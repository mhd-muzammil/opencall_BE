import type { PoolClient } from "pg";
import { query } from "../config/database.js";

export interface ReportHistorySessionRow {
  id: string;
  user_id: string;
  title: string;
  status: "DRAFT" | "COMPLETED";
  region_id: string | null;
  flex_upload_batch_id: string | null;
  renderways_upload_batch_id: string | null;
  call_plan_upload_batch_id: string | null;
  daily_call_plan_report_id: string | null;
  report_date: string | null;
  total_rows: number;
  created_at: string;
  updated_at: string;
}

export async function createHistorySession(
  client: PoolClient | null,
  session: {
    userId: string;
    title: string;
    regionId?: string | null;
    flexUploadBatchId?: string | null;
    renderwaysUploadBatchId?: string | null;
    callPlanUploadBatchId?: string | null;
  },
): Promise<ReportHistorySessionRow> {
  const sql = `
    INSERT INTO report_history_sessions (
      user_id, title, status, region_id,
      flex_upload_batch_id, renderways_upload_batch_id, call_plan_upload_batch_id
    ) VALUES ($1, $2, 'DRAFT', $3, $4, $5, $6)
    RETURNING *;
  `;
  const params = [
    session.userId,
    session.title,
    session.regionId ?? null,
    session.flexUploadBatchId ?? null,
    session.renderwaysUploadBatchId ?? null,
    session.callPlanUploadBatchId ?? null,
  ];

  const result = client
    ? await client.query<ReportHistorySessionRow>(sql, params)
    : await query<ReportHistorySessionRow>(sql, params);

  const row = result.rows[0];
  if (!row) {
    throw new Error("Failed to create history session");
  }
  return row;
}

export async function updateHistorySessionToCompleted(
  client: PoolClient | null,
  flexUploadBatchId: string,
  dailyCallPlanReportId: string,
  totalRows: number,
): Promise<ReportHistorySessionRow | null> {
  const sql = `
    UPDATE report_history_sessions
    SET
      status = 'COMPLETED',
      daily_call_plan_report_id = $2,
      total_rows = $3,
      updated_at = NOW()
    WHERE flex_upload_batch_id = $1
    RETURNING *;
  `;
  const params = [flexUploadBatchId, dailyCallPlanReportId, totalRows];

  const result = client
    ? await client.query<ReportHistorySessionRow>(sql, params)
    : await query<ReportHistorySessionRow>(sql, params);

  return result.rows[0] ?? null;
}

export async function findOrCreateCompletedHistorySessionForReport(
  client: PoolClient,
  session: {
    userId: string;
    title: string;
    regionId?: string | null;
    flexUploadBatchId: string;
    renderwaysUploadBatchId?: string | null;
    callPlanUploadBatchId?: string | null;
    dailyCallPlanReportId: string;
    totalRows: number;
  },
): Promise<ReportHistorySessionRow> {
  const updateResult = await client.query<ReportHistorySessionRow>(
    `
      WITH candidate AS (
        SELECT id
        FROM report_history_sessions
        WHERE flex_upload_batch_id = $3
          AND renderways_upload_batch_id IS NOT DISTINCT FROM $4
          AND call_plan_upload_batch_id IS NOT DISTINCT FROM $5
        ORDER BY
          CASE WHEN status = 'DRAFT' THEN 0 ELSE 1 END,
          updated_at DESC,
          id ASC
        LIMIT 1
        FOR UPDATE
      )
      UPDATE report_history_sessions sessions
      SET
        title = COALESCE(NULLIF(sessions.title, ''), $1),
        status = 'COMPLETED',
        -- Keep the region the session was originally created under. This
        -- branch also runs on every REOPEN of an existing report, and
        -- restamping the reopener's region made same-day sessions' region_ids
        -- drift apart (historically breaking carry-forward source selection,
        -- and still feeding the frontend's daySession.regionId).
        region_id = COALESCE(sessions.region_id, $2),
        daily_call_plan_report_id = $6,
        total_rows = $7,
        updated_at = NOW()
      FROM candidate
      WHERE sessions.id = candidate.id
      RETURNING sessions.*;
    `,
    [
      session.title,
      session.regionId ?? null,
      session.flexUploadBatchId,
      session.renderwaysUploadBatchId ?? null,
      session.callPlanUploadBatchId ?? null,
      session.dailyCallPlanReportId,
      session.totalRows,
    ],
  );

  const updated = updateResult.rows[0];
  if (updated) {
    return updated;
  }

  const insertResult = await client.query<ReportHistorySessionRow>(
    `
      INSERT INTO report_history_sessions (
        user_id,
        title,
        status,
        region_id,
        flex_upload_batch_id,
        renderways_upload_batch_id,
        call_plan_upload_batch_id,
        daily_call_plan_report_id,
        total_rows
      )
      VALUES ($1, $2, 'COMPLETED', $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `,
    [
      session.userId,
      session.title,
      session.regionId ?? null,
      session.flexUploadBatchId,
      session.renderwaysUploadBatchId ?? null,
      session.callPlanUploadBatchId ?? null,
      session.dailyCallPlanReportId,
      session.totalRows,
    ],
  );

  const inserted = insertResult.rows[0];
  if (!inserted) {
    throw new Error("Failed to create completed history session");
  }

  return inserted;
}

export interface ListHistorySessionsFilters {
  userId?: string;
  includeCompletedFromOthers?: boolean;
}

export async function listHistorySessions(
  filters: ListHistorySessionsFilters,
): Promise<ReportHistorySessionRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.userId && !filters.includeCompletedFromOthers) {
    params.push(filters.userId);
    conditions.push(`sessions.user_id = $${params.length}`);
  } else if (filters.userId && filters.includeCompletedFromOthers) {
    params.push(filters.userId);
    conditions.push(
      `(sessions.user_id = $${params.length} OR sessions.status = 'COMPLETED')`,
    );
  } else if (filters.includeCompletedFromOthers) {
    conditions.push(`sessions.status = 'COMPLETED'`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT
      sessions.*,
      COALESCE(
        -- The report's real business date is authoritative and locale-proof.
        -- Only fall back to parsing the (M/D/YYYY) title for rows with no
        -- linked report (e.g. drafts).
        reports.report_date,
        CASE
          WHEN title_date.parts IS NULL THEN NULL
          ELSE make_date(
            (title_date.parts)[3]::INT,
            (title_date.parts)[1]::INT,
            (title_date.parts)[2]::INT
          )
        END
      )::TEXT AS report_date
    FROM report_history_sessions sessions
    LEFT JOIN daily_call_plan_reports reports
      ON reports.id = sessions.daily_call_plan_report_id
    LEFT JOIN LATERAL regexp_match(
      sessions.title,
      'Report Session\s+([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})'
    ) AS title_date(parts) ON TRUE
    ${where}
    ORDER BY sessions.created_at DESC;
  `;
  const result = await query<ReportHistorySessionRow>(sql, params);
  return result.rows;
}

export async function getHistorySessionsByUser(
  userId: string,
): Promise<ReportHistorySessionRow[]> {
  return listHistorySessions({ userId });
}

export async function findHistorySessionById(
  id: string,
): Promise<ReportHistorySessionRow | null> {
  const sql = `
    SELECT
      sessions.*,
      COALESCE(
        -- The report's real business date is authoritative and locale-proof.
        -- Only fall back to parsing the (M/D/YYYY) title for rows with no
        -- linked report (e.g. drafts).
        reports.report_date,
        CASE
          WHEN title_date.parts IS NULL THEN NULL
          ELSE make_date(
            (title_date.parts)[3]::INT,
            (title_date.parts)[1]::INT,
            (title_date.parts)[2]::INT
          )
        END
      )::TEXT AS report_date
    FROM report_history_sessions sessions
    LEFT JOIN daily_call_plan_reports reports
      ON reports.id = sessions.daily_call_plan_report_id
    LEFT JOIN LATERAL regexp_match(
      sessions.title,
      'Report Session\s+([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})'
    ) AS title_date(parts) ON TRUE
    WHERE sessions.id = $1
    LIMIT 1;
  `;
  const result = await query<ReportHistorySessionRow>(sql, [id]);
  return result.rows[0] ?? null;
}

/**
 * The newest COMPLETED report session that has a linked report + flex batch — i.e. the
 * globally-shared "latest report" that any viewer (including special-access logins) sees.
 * Additive read helper; does not affect existing history behaviour.
 */
export async function findLatestCompletedReportSession(): Promise<ReportHistorySessionRow | null> {
  const sql = `
    SELECT
      sessions.*,
      reports.report_date::TEXT AS report_date
    FROM report_history_sessions sessions
    JOIN daily_call_plan_reports reports
      ON reports.id = sessions.daily_call_plan_report_id
    WHERE sessions.status = 'COMPLETED'
      AND sessions.flex_upload_batch_id IS NOT NULL
    ORDER BY reports.report_date DESC NULLS LAST, sessions.created_at DESC
    LIMIT 1;
  `;
  const result = await query<ReportHistorySessionRow>(sql);
  return result.rows[0] ?? null;
}

/**
 * The newest COMPLETED report session VISIBLE TO A REGION SET — the scoped
 * equivalent of `findLatestCompletedReportSession` above.
 *
 * Why this exists: the unscoped helper is a global LIMIT 1, so a special-access
 * login granted Chennai + Kanchipuram followed whichever region uploaded last
 * ANYWHERE. A Vellore upload silently moved them onto a different report,
 * changing `reportId` under an open records grid (which reset their filters) and
 * churning the row set beneath an open editor.
 *
 * The scope rule matches the frontend's auto-switch: region COMPATIBILITY, not
 * equality. A session with `region_id IS NULL` is a worker/combined upload that
 * contains every region's rows and must be included — those are the main source
 * of fresh data. A session scoped to a region outside the grant is skipped:
 * a region-scoped upload carries other regions' tickets forward verbatim, so
 * skipping it loses no data and buys a stable report.
 *
 * `regionIds = null` means "all regions granted" and behaves like the unscoped
 * helper. `reportDate` pins to one day; omit it for "latest available".
 */
export async function findLatestCompletedReportSessionForRegions(
  regionIds: readonly string[] | null,
  options?: { reportDate?: string | undefined },
): Promise<ReportHistorySessionRow | null> {
  const reportDate = options?.reportDate ?? null;
  const sql = `
    SELECT
      sessions.*,
      reports.report_date::TEXT AS report_date
    FROM report_history_sessions sessions
    JOIN daily_call_plan_reports reports
      ON reports.id = sessions.daily_call_plan_report_id
    WHERE sessions.status = 'COMPLETED'
      AND sessions.flex_upload_batch_id IS NOT NULL
      AND (
        $1::uuid[] IS NULL
        OR sessions.region_id IS NULL
        OR sessions.region_id = ANY($1::uuid[])
      )
      AND ($2::date IS NULL OR reports.report_date = $2::date)
    ORDER BY reports.report_date DESC NULLS LAST, sessions.created_at DESC
    LIMIT 1;
  `;
  // Only an explicit `null` widens to all regions. An EMPTY array must stay
  // empty — converting it to null would turn a credential with no granted
  // region into an all-regions one.
  const result = await query<ReportHistorySessionRow>(sql, [
    regionIds === null ? null : [...regionIds],
    reportDate,
  ]);
  return result.rows[0] ?? null;
}

/**
 * Distinct report dates a region set can open, newest first.
 *
 * The history panel is driven by `/report-history`, which is user-only, so a
 * special-access login had `historySessions` permanently empty and no way to
 * look at — let alone correct — any day but the current one. This is the scoped
 * substitute: just the days, which is all a date picker needs. Same region
 * compatibility rule as `findLatestCompletedReportSessionForRegions`.
 */
export async function findReportDatesForRegions(
  regionIds: readonly string[] | null,
  limit = 60,
): Promise<string[]> {
  const sql = `
    SELECT DISTINCT reports.report_date::TEXT AS report_date
    FROM report_history_sessions sessions
    JOIN daily_call_plan_reports reports
      ON reports.id = sessions.daily_call_plan_report_id
    WHERE sessions.status = 'COMPLETED'
      AND sessions.flex_upload_batch_id IS NOT NULL
      AND reports.report_date IS NOT NULL
      AND (
        $1::uuid[] IS NULL
        OR sessions.region_id IS NULL
        OR sessions.region_id = ANY($1::uuid[])
      )
    ORDER BY report_date DESC
    LIMIT $2;
  `;
  const result = await query<{ report_date: string }>(sql, [
    regionIds === null ? null : [...regionIds],
    limit,
  ]);
  return result.rows.map((row) => row.report_date);
}

/**
 * The newest COMPLETED session whose linked report is dated `reportDate`
 * (YYYY-MM-DD) — the same session the frontend "Specific Date" productivity
 * view restores. Used by the Final-EOD freeze to regenerate that day's report
 * server-side. Additive read helper.
 */
export async function findLatestCompletedSessionByReportDate(
  reportDate: string,
): Promise<ReportHistorySessionRow | null> {
  const sql = `
    SELECT
      sessions.*,
      reports.report_date::TEXT AS report_date
    FROM report_history_sessions sessions
    JOIN daily_call_plan_reports reports
      ON reports.id = sessions.daily_call_plan_report_id
    WHERE sessions.status = 'COMPLETED'
      AND sessions.flex_upload_batch_id IS NOT NULL
      AND reports.report_date = $1
    ORDER BY sessions.updated_at DESC, sessions.created_at DESC
    LIMIT 1;
  `;
  const result = await query<ReportHistorySessionRow>(sql, [reportDate]);
  return result.rows[0] ?? null;
}

export async function getHistorySessionById(
  id: string,
  userId: string,
): Promise<ReportHistorySessionRow | null> {
  const sql = `
    SELECT
      sessions.*,
      COALESCE(
        -- The report's real business date is authoritative and locale-proof.
        -- Only fall back to parsing the (M/D/YYYY) title for rows with no
        -- linked report (e.g. drafts).
        reports.report_date,
        CASE
          WHEN title_date.parts IS NULL THEN NULL
          ELSE make_date(
            (title_date.parts)[3]::INT,
            (title_date.parts)[1]::INT,
            (title_date.parts)[2]::INT
          )
        END
      )::TEXT AS report_date
    FROM report_history_sessions sessions
    LEFT JOIN daily_call_plan_reports reports
      ON reports.id = sessions.daily_call_plan_report_id
    LEFT JOIN LATERAL regexp_match(
      sessions.title,
      'Report Session\s+([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})'
    ) AS title_date(parts) ON TRUE
    WHERE sessions.id = $1 AND sessions.user_id = $2
    LIMIT 1;
  `;
  const result = await query<ReportHistorySessionRow>(sql, [id, userId]);
  return result.rows[0] ?? null;
}

export async function updateHistorySessionTitle(
  id: string,
  userId: string,
  title: string,
): Promise<ReportHistorySessionRow | null> {
  const sql = `
    UPDATE report_history_sessions
    SET title = $3, updated_at = NOW()
    WHERE id = $1 AND user_id = $2
    RETURNING *;
  `;
  const result = await query<ReportHistorySessionRow>(sql, [id, userId, title]);
  return result.rows[0] ?? null;
}

export async function deleteHistorySession(
  id: string,
  userId: string,
): Promise<boolean> {
  const sql = `
    DELETE FROM report_history_sessions
    WHERE id = $1 AND user_id = $2;
  `;
  const result = await query(sql, [id, userId]);
  return (result.rowCount ?? 0) > 0;
}
