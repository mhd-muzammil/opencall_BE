import { query } from "../config/database.js";

/**
 * Read/queue helpers for wiring closed calls into the existing HP warranty subsystem.
 * Fully additive: it reuses the existing warranty tables (hp_warranty_cache,
 * warranty_jobs, warranty_job_items) — no new table. Closed-call auto lookups are
 * enqueued under ONE standing "system" job (created_by NULL) so the existing Playwright
 * worker drains them exactly like an upload job. UNIQUE(job_id, serial) makes enqueue
 * idempotent, and hp_warranty_cache makes the actual HP fetch happen once per serial ever.
 */

const CLOSED_JOB_SENTINEL = "__closed_calls_auto__";

/** The warranty tables are applied by a script, not a numbered migration — guard reads. */
export async function warrantyTablesPresent(): Promise<boolean> {
  const result = await query<{ present: boolean }>(
    `SELECT (
        to_regclass('public.hp_warranty_cache') IS NOT NULL
        AND to_regclass('public.warranty_jobs') IS NOT NULL
        AND to_regclass('public.warranty_job_items') IS NOT NULL
      ) AS present`,
  );
  return result.rows[0]?.present ?? false;
}

/** The single standing job that all closed-call auto lookups are enqueued under. */
export async function getOrCreateClosedCallsJobId(): Promise<string> {
  const existing = await query<{ id: string }>(
    `SELECT id FROM warranty_jobs WHERE original_file_name = $1
     ORDER BY created_at ASC LIMIT 1`,
    [CLOSED_JOB_SENTINEL],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const inserted = await query<{ id: string }>(
    `INSERT INTO warranty_jobs
       (original_file_name, stored_file_path, status, total_rows, unique_serials, created_by, region_id)
     VALUES ($1, '', 'processing', 0, 0, NULL, NULL)
     RETURNING id`,
    [CLOSED_JOB_SENTINEL],
  );
  return inserted.rows[0]!.id;
}

/** How many serials were enqueued under the standing job today (IST-day of the DB). */
export async function countEnqueuedTodayForJob(jobId: string): Promise<number> {
  const result = await query<{ n: string }>(
    `SELECT COUNT(*) AS n
       FROM warranty_job_items
      WHERE job_id = $1
        AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
    [jobId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Of the given serials, which currently have a pending/processing lookup in flight. */
export async function findQueuedSerials(
  serials: readonly string[],
): Promise<string[]> {
  if (serials.length === 0) return [];
  const result = await query<{ serial: string }>(
    `SELECT DISTINCT serial
       FROM warranty_job_items
      WHERE serial = ANY($1::VARCHAR[])
        AND state IN ('pending', 'processing')`,
    [[...serials]],
  );
  return result.rows.map((r) => r.serial);
}

/** CTE selecting the most recently active completed report's id. */
const LATEST_REPORT_CTE = `
  WITH latest AS (
    SELECT sessions.daily_call_plan_report_id AS report_id
      FROM report_history_sessions sessions
     WHERE sessions.status = 'COMPLETED'
       AND sessions.daily_call_plan_report_id IS NOT NULL
     ORDER BY sessions.updated_at DESC, sessions.id DESC
     LIMIT 1
  )
`;

/**
 * Serials from the CLOSED rows of the most recently active completed report — the
 * source for the worker's unattended daily sweep. Best-effort: closed calls carry over
 * between reports, so approximate selection is fine (the cache accumulates over days).
 */
export async function getLatestReportClosedSerials(): Promise<string[]> {
  const result = await query<{ product_serial_no: string | null }>(
    `${LATEST_REPORT_CTE}
      SELECT DISTINCT rows.product_serial_no
        FROM latest
        JOIN daily_call_plan_report_rows rows
          ON rows.report_id = latest.report_id
       WHERE NOT rows.is_excluded
         AND (rows.change_type = 'CLOSED' OR rows.same_day_closed = TRUE)
         AND rows.product_serial_no IS NOT NULL
         AND TRIM(rows.product_serial_no) <> ''`,
  );
  return result.rows
    .map((r) => r.product_serial_no)
    .filter((s): s is string => Boolean(s));
}

export interface ClosedCallRow {
  ticketId: string;
  customer: string;
  serial: string;
  region: string;
  model: string;
}

/**
 * The CLOSED rows of the latest completed report, with the fields the warranty list shows.
 * Includes rows with blank serials (they render as NO_SERIAL). One row per ticket (the most
 * recent), so the list matches the closed-call ledger.
 */
export async function getLatestReportClosedCalls(): Promise<ClosedCallRow[]> {
  const result = await query<{
    ticket_id: string | null;
    customer_name: string | null;
    product_serial_no: string | null;
    work_location: string | null;
    product: string | null;
  }>(
    `${LATEST_REPORT_CTE}
      SELECT DISTINCT ON (rows.ticket_id)
             rows.ticket_id,
             rows.customer_name,
             rows.product_serial_no,
             rows.work_location,
             rows.product
        FROM latest
        JOIN daily_call_plan_report_rows rows
          ON rows.report_id = latest.report_id
       WHERE NOT rows.is_excluded
         AND (rows.change_type = 'CLOSED' OR rows.same_day_closed = TRUE)
       ORDER BY
         rows.ticket_id,
         (rows.product_serial_no IS NOT NULL AND TRIM(rows.product_serial_no) <> '') DESC,
         rows.id DESC`,

  );
  return result.rows.map((r) => ({
    ticketId: (r.ticket_id ?? "").trim(),
    customer: (r.customer_name ?? "").trim(),
    serial: (r.product_serial_no ?? "").trim(),
    region: (r.work_location ?? "").trim(),
    model: (r.product ?? "").trim(),
  }));
}
