import type { PoolClient } from "pg";
import { pool, query } from "../config/database.js";

/**
 * Imported Flex RAW export rows. This is the historical Flex data the standalone
 * "raw data" dashboard is built from, brought into OpenCall so the Closed Calls region
 * cards can show what the raw file itself reports as closed.
 *
 * Unlike case_closure_dates there is no de-duplication: the raw export legitimately
 * repeats a work order across months, and the card is meant to show the raw file's own
 * count.
 */

export type FlexRawStatusGroup = "closed" | "cancelled" | "resolved" | "open";

export interface FlexRawRecordInput {
  ticketNo: string;
  caseId: string;
  workLocation: string;
  callStatus: string;
  statusGroup: FlexRawStatusGroup;
  /** YYYY-MM-DD, or null when the source date is unusable. */
  startDate: string | null;
  /** Sortable "YYYY-MM" key from the raw export's Month column; '' when unknown. */
  sourceMonth: string;
  /** The raw export's WO Closed date (YYYY-MM-DD), or null when unusable. */
  closedOn: string | null;
}

/** Normalises a lookup/grouping key exactly the way writes and reads must agree on. */
export function normalizeRawKey(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * Whether migration 056's closed_on column exists yet.
 *
 * A push deploys BEFORE its migration can run (the 2026-08-06 lesson), so every
 * read and write here must work against the old schema: without the column,
 * imports store no dates, day filters report dayPrecise=false and the frontend
 * keeps its month-level fallback. Only a positive answer is cached — the first
 * call after the migration runs flips it on with no restart.
 */
let closedOnColumnKnownPresent = false;
async function hasClosedOnColumn(): Promise<boolean> {
  if (closedOnColumnKnownPresent) return true;
  const result = await query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'flex_raw_records'
        AND column_name = 'closed_on'`,
  );
  closedOnColumnKnownPresent = (result.rowCount ?? 0) > 0;
  return closedOnColumnKnownPresent;
}

/** Rows are inserted in batches so an 11k-row import is a handful of round trips. */
const INSERT_BATCH_SIZE = 500;

/**
 * Replaces the whole raw-record set in one transaction, so an import is all-or-nothing
 * and re-importing fully refreshes the data.
 */
export async function replaceFlexRawRecords(
  rows: readonly FlexRawRecordInput[],
): Promise<number> {
  const withClosedOn = await hasClosedOnColumn();
  const perRow = withClosedOn ? 8 : 7;
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM flex_raw_records");

    for (let start = 0; start < rows.length; start += INSERT_BATCH_SIZE) {
      const batch = rows.slice(start, start + INSERT_BATCH_SIZE);
      const values: unknown[] = [];
      const tuples: string[] = [];

      batch.forEach((row, index) => {
        const base = index * perRow;
        const placeholders = [
          `$${base + 1}`, `$${base + 2}`, `$${base + 3}`, `$${base + 4}`,
          `$${base + 5}`, `$${base + 6}::date`, `$${base + 7}`,
        ];
        values.push(
          row.ticketNo,
          row.caseId,
          row.workLocation,
          row.callStatus,
          row.statusGroup,
          row.startDate,
          row.sourceMonth,
        );
        if (withClosedOn) {
          placeholders.push(`$${base + 8}::date`);
          values.push(row.closedOn);
        }
        tuples.push(`(${placeholders.join(", ")})`);
      });

      await client.query(
        `INSERT INTO flex_raw_records
           (ticket_no, case_id, work_location, call_status, status_group, start_date, source_month${
             withClosedOn ? ", closed_on" : ""
           })
         VALUES ${tuples.join(", ")}`,
        values,
      );
    }

    await client.query("COMMIT");
    return rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface FlexRawAspCount {
  aspCode: string;
  total: number;
  closed: number;
  cancelled: number;
  resolved: number;
  open: number;
}

export interface FlexRawAspMonthCount extends FlexRawAspCount {
  /** '' means the "All months" rollup for that ASP. */
  month: string;
}

export interface FlexRawSummary {
  /** Closed rows across every ASP, all months. */
  total: number;
  closed: number;
  /** Per Work Location, all months, biggest first. */
  byAsp: FlexRawAspCount[];
  /** Per Work Location per month, so the card counts can be scoped to one month. */
  byAspMonth: FlexRawAspMonthCount[];
  /** Distinct months present, ascending ("YYYY-MM"). */
  months: string[];
  /**
   * True when a day range was requested AND closed_on filtering was available.
   * The frontend keeps its month-level fallback whenever this is not true, so
   * an old backend or an unmigrated table degrades honestly, not wrongly.
   */
  dayPrecise?: boolean;
  /** Closed rows with no usable close date — invisible to ANY day range. */
  undatedClosed?: number;
}

/**
 * Counts the raw records grouped by Work Location and month. Rows whose Work Location is
 * blank or is not an ASP code (the raw export has HP engineer ids and 'FCT CCO' in that
 * column) still contribute to the overall totals, they simply do not land on a region
 * card.
 */
export async function summarizeFlexRawRecords(
  opts: { dateFrom?: string; dateTo?: string } = {},
): Promise<FlexRawSummary> {
  const dateFrom = opts.dateFrom ?? "";
  const dateTo = opts.dateTo ?? "";
  // Day scope only when a bound was asked for AND the column exists — the
  // unscoped query must never mention closed_on, or a not-yet-migrated table
  // would break the cards entirely instead of degrading to month-level.
  const dayScoped = (dateFrom !== "" || dateTo !== "") && (await hasClosedOnColumn());

  const result = await query<{
    work_location: string;
    source_month: string;
    total: string;
    closed: string;
    cancelled: string;
    resolved: string;
    open: string;
  }>(
    `SELECT
       work_location,
       source_month,
       COUNT(*)::TEXT                                            AS total,
       COUNT(*) FILTER (WHERE status_group = 'closed')::TEXT     AS closed,
       COUNT(*) FILTER (WHERE status_group = 'cancelled')::TEXT  AS cancelled,
       COUNT(*) FILTER (WHERE status_group = 'resolved')::TEXT   AS resolved,
       COUNT(*) FILTER (WHERE status_group = 'open')::TEXT       AS open
     FROM flex_raw_records
     ${
       dayScoped
         ? `WHERE closed_on IS NOT NULL
              AND ($1 = '' OR closed_on >= $1::date)
              AND ($2 = '' OR closed_on <= $2::date)`
         : ""
     }
     GROUP BY work_location, source_month`,
    dayScoped ? [dateFrom, dateTo] : [],
  );

  const byAspMonth: FlexRawAspMonthCount[] = result.rows.map((row) => ({
    aspCode: row.work_location,
    month: row.source_month,
    total: Number(row.total),
    closed: Number(row.closed),
    cancelled: Number(row.cancelled),
    resolved: Number(row.resolved),
    open: Number(row.open),
  }));

  // Roll the per-month rows up into per-ASP totals (the "All months" view).
  const aspRollup = new Map<string, FlexRawAspCount>();
  const monthSet = new Set<string>();
  for (const row of byAspMonth) {
    if (row.month) monthSet.add(row.month);
    let entry = aspRollup.get(row.aspCode);
    if (!entry) {
      entry = { aspCode: row.aspCode, total: 0, closed: 0, cancelled: 0, resolved: 0, open: 0 };
      aspRollup.set(row.aspCode, entry);
    }
    entry.total += row.total;
    entry.closed += row.closed;
    entry.cancelled += row.cancelled;
    entry.resolved += row.resolved;
    entry.open += row.open;
  }

  const byAsp = [...aspRollup.values()].sort((a, b) => b.total - a.total);

  // How many closed rows no day range can ever see. Counted only when a range
  // was applied — it exists so the card can say "N undated" instead of quietly
  // under-reporting.
  let undatedClosed = 0;
  if (dayScoped) {
    const undated = await query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count
         FROM flex_raw_records
        WHERE status_group = 'closed' AND closed_on IS NULL`,
    );
    undatedClosed = Number(undated.rows[0]?.count ?? 0);
  }

  return {
    total: byAsp.reduce((sum, entry) => sum + entry.total, 0),
    closed: byAsp.reduce((sum, entry) => sum + entry.closed, 0),
    byAsp,
    byAspMonth,
    months: [...monthSet].sort(),
    dayPrecise: dayScoped,
    undatedClosed,
  };
}

export async function countFlexRawRecords(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM flex_raw_records`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

export interface FlexRawRecordRow {
  ticketNo: string;
  caseId: string;
  workLocation: string;
  callStatus: string;
  month: string;
  /** The raw export's WO Closed date, or null (also null on an unmigrated table). */
  closedOn: string | null;
}

export interface FlexRawRecordList {
  rows: FlexRawRecordRow[];
  total: number;
}

const RECORD_LIST_LIMIT = 2000;

/**
 * The individual raw records behind a region card's "Raw data closed" count — filtered by
 * ASP ('' = every ASP), a month range (both '' = every month) and status group ('' = every
 * status). When either month bound is set, rows with a blank month are excluded (they
 * belong to no month range). Capped; `total` is the true count.
 */
export async function listFlexRawRecords(filter: {
  aspCode: string;
  monthFrom: string;
  monthTo: string;
  /** Day bounds on the WO Closed date ('' = unbounded). Need migration 056. */
  dateFrom?: string;
  dateTo?: string;
  statusGroup: string;
  /**
   * ASP codes the caller may read, or `null` for unrestricted. Enforced here as well
   * as in the controller so an empty `aspCode` ("every region") can never widen a
   * region-scoped principal's view.
   */
  allowedAspCodes?: string[] | null;
}): Promise<FlexRawRecordList> {
  const withClosedOn = await hasClosedOnColumn();
  const dateFrom = filter.dateFrom ?? "";
  const dateTo = filter.dateTo ?? "";
  // Day bounds silently no-op without the column — same month-level degradation
  // as the summary, never an error.
  const dayScoped = withClosedOn && (dateFrom !== "" || dateTo !== "");

  const result = await query<{
    ticket_no: string;
    case_id: string;
    work_location: string;
    call_status: string;
    source_month: string;
    closed_on?: string | null;
    total_count: string;
  }>(
    `SELECT ticket_no, case_id, work_location, call_status, source_month,
            ${withClosedOn ? "closed_on::text AS closed_on," : ""}
            COUNT(*) OVER()::TEXT AS total_count
       FROM flex_raw_records
      WHERE ($1 = '' OR status_group = $1)
        AND ($2 = '' OR work_location = $2)
        AND ($5::text[] IS NULL OR work_location = ANY($5::text[]))
        AND (
          ($3 = '' AND $4 = '')
          OR (source_month <> ''
              AND ($3 = '' OR source_month >= $3)
              AND ($4 = '' OR source_month <= $4))
        )
        ${
          dayScoped
            ? `AND closed_on IS NOT NULL
               AND ($6 = '' OR closed_on >= $6::date)
               AND ($7 = '' OR closed_on <= $7::date)`
            : ""
        }
      ORDER BY ${withClosedOn ? "closed_on DESC NULLS LAST, " : ""}source_month DESC, ticket_no
      LIMIT ${RECORD_LIST_LIMIT}`,
    [
      filter.statusGroup,
      filter.aspCode,
      filter.monthFrom,
      filter.monthTo,
      filter.allowedAspCodes ?? null,
      ...(dayScoped ? [dateFrom, dateTo] : []),
    ],
  );

  return {
    rows: result.rows.map((row) => ({
      ticketNo: row.ticket_no,
      caseId: row.case_id,
      workLocation: row.work_location,
      callStatus: row.call_status,
      month: row.source_month,
      closedOn: row.closed_on ?? null,
    })),
    total: Number(result.rows[0]?.total_count ?? 0),
  };
}
