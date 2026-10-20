import { query } from "../config/database.js";
import type { ManualCarryForwardField } from "../types/reportGeneration.js";

export interface RcaOpenCaseDb {
  row_id: string;
  ticket_id: string;
  ticket_key: string;
  case_id: string | null;
  customer_name: string | null;
  account_name: string | null;
  customer_mail: string | null;
  contact: string | null;
  work_location: string | null;
  engineer: string | null;
  rtpl_status: string | null;
  segment: string | null;
  location: string | null;
  product: string | null;
  remarks: string | null;
  manual_notes: string | null;
  rca: string | null;
  case_created_time: string | null;
  row_updated_at: string | null;
  row_updated_by: string | null;
  carried_forward_fields: ManualCarryForwardField[];
  manual_fields_completed: boolean;
  match_status: string;
  report_id: string;
  report_date: string;
  report_region_id: string | null;
  report_region_name: string | null;
  report_region_code: string | null;
  last_action_at: string | null;
  last_action_user_id: string | null;
  last_action_username: string | null;
  last_action_email: string | null;
  first_seen_date: string | null;
  total_appearances: number;
  total_actions: number;
}

export interface RcaOpenCasesQuery {
  workLocations?: readonly string[] | null;
  search?: string | null;
  /**
   * Window in days, anchored at the most recent report_date. Reports older
   * than (maxDate - recencyDays) are excluded so cases that haven't been
   * refreshed in weeks don't pollute the "currently open" caseload.
   */
  recencyDays?: number;
}

export const DEFAULT_RCA_RECENCY_DAYS = 7;

/**
 * Returns every case row in the most recent daily report (i.e. cases that
 * are still open today) along with cross-report aggregates: when the case
 * was last manually touched, how many days it has been open, and who took
 * the last action. Region scoping is applied on `work_location`, which holds
 * the ASP code that maps to a region via aspCodesForRegion(...).
 */
export async function listOpenRcaCases(
  filters: RcaOpenCasesQuery,
): Promise<RcaOpenCaseDb[]> {
  const params: unknown[] = [];

  const recencyDays = Math.max(1, filters.recencyDays ?? DEFAULT_RCA_RECENCY_DAYS);
  params.push(recencyDays);
  const recencyParam = `$${params.length}`;

  const rowConditions: string[] = ["NULLIF(TRIM(rows.ticket_id), '') IS NOT NULL"];

  if (filters.workLocations && filters.workLocations.length > 0) {
    params.push(filters.workLocations.map((c) => c.trim().toUpperCase()));
    rowConditions.push(
      `UPPER(TRIM(COALESCE(rows.work_location, ''))) = ANY($${params.length}::text[])`,
    );
  }

  if (filters.search) {
    params.push(`%${filters.search.trim()}%`);
    rowConditions.push(
      `(rows.ticket_id ILIKE $${params.length}
        OR COALESCE(rows.case_id, '') ILIKE $${params.length}
        OR COALESCE(rows.customer_name, '') ILIKE $${params.length}
        OR COALESCE(rows.account_name, '') ILIKE $${params.length})`,
    );
  }

  const rowWhereClause = `WHERE ${rowConditions.join(" AND ")}`;

  // Two-stage report selection:
  //   1. `candidate_reports` keeps only reports inside the recency window
  //      (max(report_date) - recencyDays), so abandoned regions don't pollute
  //      the "currently open" set with weeks-old rows.
  //   2. `latest_per_canonical_region` picks ONE report per canonical region
  //      name. The `regions` table holds duplicates by name (e.g. Chennai
  //      appears twice — once with the ASP code, once with a short code).
  //      Grouping by region_id would double-count Chennai; grouping by
  //      UPPER(TRIM(name)) collapses them.
  const sql = `
    WITH max_report AS (
      SELECT MAX(report_date) AS max_d
      FROM daily_call_plan_reports
    ),
    candidate_reports AS (
      SELECT
        r.id,
        r.report_date,
        r.region_id,
        r.created_at,
        UPPER(TRIM(COALESCE(reg.name, ''))) AS canonical_region_name,
        reg.name AS report_region_name,
        reg.code AS report_region_code
      FROM daily_call_plan_reports r
      LEFT JOIN regions reg ON reg.id = r.region_id
      CROSS JOIN max_report
      WHERE max_report.max_d IS NOT NULL
        AND r.report_date >= max_report.max_d - (${recencyParam} || ' days')::interval
    ),
    latest_per_canonical_region AS (
      SELECT DISTINCT ON (canonical_region_name)
        id,
        report_date,
        region_id,
        created_at,
        canonical_region_name,
        report_region_name,
        report_region_code
      FROM candidate_reports
      ORDER BY canonical_region_name, report_date DESC, created_at DESC
    ),
    latest_rows_raw AS (
      SELECT
        rows.id AS row_id,
        rows.ticket_id,
        UPPER(TRIM(rows.ticket_id)) AS ticket_key,
        rows.case_id,
        rows.customer_name,
        rows.account_name,
        rows.customer_mail,
        rows.contact,
        rows.work_location,
        rows.engineer,
        rows.rtpl_status,
        rows.segment,
        rows.location,
        rows.product,
        rows.remarks,
        rows.manual_notes,
        rows.rca,
        rows.case_created_time::text AS case_created_time,
        rows.updated_at::text AS row_updated_at,
        rows.updated_by AS row_updated_by,
        rows.carried_forward_fields,
        rows.manual_fields_completed,
        rows.match_status,
        latest.id AS report_id,
        latest.report_date::text AS report_date,
        latest.created_at AS report_created_at,
        latest.region_id AS report_region_id,
        latest.report_region_name,
        latest.report_region_code
      FROM latest_per_canonical_region latest
      JOIN daily_call_plan_report_rows rows ON rows.report_id = latest.id
      ${rowWhereClause}
    ),
    latest_rows AS (
      SELECT DISTINCT ON (ticket_key) *
      FROM latest_rows_raw
      ORDER BY ticket_key, report_date DESC, report_created_at DESC
    ),
    -- Per-ticket chronological appearances with the previous appearance's
    -- operator-editable state attached via LAG. We compare these row values
    -- to detect a real "action" (operator edit OR upload that actually
    -- changed something) vs a no-op carry-forward.
    appearance_diffs AS (
      SELECT
        UPPER(TRIM(r.ticket_id)) AS ticket_key,
        rpt.report_date,
        rpt.created_at AS report_created_at,
        r.updated_at,
        -- Current operator-editable state. Keep this list aligned with
        -- MANUAL_CARRY_FORWARD_FIELDS + OPTIONAL_MANUAL_CARRY_FORWARD_FIELDS.
        ROW(
          NULLIF(TRIM(COALESCE(r.rtpl_status, '')), ''),
          NULLIF(TRIM(COALESCE(r.segment,     '')), ''),
          NULLIF(TRIM(COALESCE(r.engineer,    '')), ''),
          NULLIF(TRIM(COALESCE(r.location,    '')), ''),
          r.case_created_time,
          NULLIF(TRIM(COALESCE(r.hp_owner_status, '')), ''),
          NULLIF(TRIM(COALESCE(r.customer_mail,   '')), ''),
          NULLIF(TRIM(COALESCE(r.rca,             '')), ''),
          NULLIF(TRIM(COALESCE(r.remarks,         '')), ''),
          NULLIF(TRIM(COALESCE(r.manual_notes,    '')), '')
        ) AS cur_state,
        LAG(
          ROW(
            NULLIF(TRIM(COALESCE(r.rtpl_status, '')), ''),
            NULLIF(TRIM(COALESCE(r.segment,     '')), ''),
            NULLIF(TRIM(COALESCE(r.engineer,    '')), ''),
            NULLIF(TRIM(COALESCE(r.location,    '')), ''),
            r.case_created_time,
            NULLIF(TRIM(COALESCE(r.hp_owner_status, '')), ''),
            NULLIF(TRIM(COALESCE(r.customer_mail,   '')), ''),
            NULLIF(TRIM(COALESCE(r.rca,             '')), ''),
            NULLIF(TRIM(COALESCE(r.remarks,         '')), ''),
            NULLIF(TRIM(COALESCE(r.manual_notes,    '')), '')
          )
        ) OVER (
          PARTITION BY UPPER(TRIM(r.ticket_id))
          ORDER BY rpt.report_date ASC, rpt.created_at ASC, r.id ASC
        ) AS prev_state
      FROM daily_call_plan_report_rows r
      JOIN daily_call_plan_reports rpt ON rpt.id = r.report_id
      WHERE UPPER(TRIM(r.ticket_id)) IN (SELECT ticket_key FROM latest_rows)
    ),
    history_agg AS (
      -- An "action" on a report day means: an operator manually edited the
      -- row (updated_at IS NOT NULL), OR it's the case's first appearance
      -- (prev_state IS NULL), OR the row's operator-editable state changed
      -- vs the previous appearance (cur_state IS DISTINCT FROM prev_state).
      -- Pure carry-forward days where nothing changed are NOT actions.
      -- Do not narrow this back to "updated_at IS NOT NULL" — that misses
      -- upload-driven changes. Do not broaden to "jsonb_array_length <
      -- TOTAL" — that counts identical-value uploads as actions.
      SELECT
        ticket_key,
        MAX(
          CASE
            WHEN updated_at IS NOT NULL
              OR prev_state IS NULL
              OR cur_state IS DISTINCT FROM prev_state
            THEN COALESCE(updated_at, report_created_at)
          END
        )::text AS last_action_at,
        MIN(report_date)::text AS first_seen_date,
        COUNT(DISTINCT report_date)::int AS total_appearances,
        COUNT(
          CASE
            WHEN updated_at IS NOT NULL
              OR prev_state IS NULL
              OR cur_state IS DISTINCT FROM prev_state
            THEN 1
          END
        )::int AS total_actions
      FROM appearance_diffs
      GROUP BY ticket_key
    ),
    last_actor AS (
      SELECT DISTINCT ON (UPPER(TRIM(r.ticket_id)))
        UPPER(TRIM(r.ticket_id)) AS ticket_key,
        r.updated_by AS user_id,
        u.username,
        u.email
      FROM daily_call_plan_report_rows r
      LEFT JOIN users u ON u.id = r.updated_by
      WHERE r.updated_at IS NOT NULL
        AND r.updated_by IS NOT NULL
        AND UPPER(TRIM(r.ticket_id)) IN (SELECT ticket_key FROM latest_rows)
      ORDER BY UPPER(TRIM(r.ticket_id)), r.updated_at DESC
    )
    SELECT
      lr.*,
      ha.last_action_at,
      ha.first_seen_date,
      COALESCE(ha.total_appearances, 1) AS total_appearances,
      COALESCE(ha.total_actions, 0) AS total_actions,
      la.user_id AS last_action_user_id,
      la.username AS last_action_username,
      la.email AS last_action_email
    FROM latest_rows lr
    LEFT JOIN history_agg ha ON ha.ticket_key = lr.ticket_key
    LEFT JOIN last_actor la ON la.ticket_key = lr.ticket_key
    ORDER BY lr.ticket_id ASC
  `;

  const result = await query<RcaOpenCaseDb>(sql, params);
  return result.rows;
}

export interface RcaCaseTimelineEntryDb {
  row_id: string;
  report_id: string;
  report_date: string;
  report_created_at: string;
  region_id: string | null;
  region_name: string | null;
  region_code: string | null;
  work_location: string | null;
  rtpl_status: string | null;
  engineer: string | null;
  location: string | null;
  segment: string | null;
  remarks: string | null;
  manual_notes: string | null;
  rca: string | null;
  customer_name: string | null;
  account_name: string | null;
  customer_mail: string | null;
  case_id: string | null;
  case_created_time: string | null;
  ticket_id: string;
  match_status: string;
  carried_forward_fields: ManualCarryForwardField[];
  manual_fields_completed: boolean;
  manual_fields_missing: ManualCarryForwardField[];
  updated_at: string | null;
  updated_by: string | null;
  updated_by_username: string | null;
  updated_by_email: string | null;
}

/**
 * Returns every appearance of a case (by normalized ticket id) across all
 * daily reports, oldest first. Used to render the day-by-day RCA timeline.
 */
export async function getRcaCaseTimeline(
  ticketKey: string,
  workLocations?: readonly string[] | null,
): Promise<RcaCaseTimelineEntryDb[]> {
  const params: unknown[] = [ticketKey];
  let workLocationClause = "";
  if (workLocations && workLocations.length > 0) {
    params.push(workLocations.map((c) => c.trim().toUpperCase()));
    workLocationClause = `AND UPPER(TRIM(COALESCE(rows.work_location, ''))) = ANY($${params.length}::text[])`;
  }

  const sql = `
    SELECT
      rows.id AS row_id,
      reports.id AS report_id,
      reports.report_date::text AS report_date,
      reports.created_at::text AS report_created_at,
      reports.region_id AS region_id,
      reg.name AS region_name,
      reg.code AS region_code,
      rows.work_location,
      rows.rtpl_status,
      rows.engineer,
      rows.location,
      rows.segment,
      rows.remarks,
      rows.manual_notes,
      rows.rca,
      rows.customer_name,
      rows.account_name,
      rows.customer_mail,
      rows.case_id,
      rows.case_created_time::text AS case_created_time,
      rows.ticket_id,
      rows.match_status,
      rows.carried_forward_fields,
      rows.manual_fields_completed,
      rows.manual_fields_missing,
      rows.updated_at::text AS updated_at,
      rows.updated_by,
      u.username AS updated_by_username,
      u.email AS updated_by_email
    FROM daily_call_plan_report_rows rows
    JOIN daily_call_plan_reports reports ON reports.id = rows.report_id
    LEFT JOIN regions reg ON reg.id = reports.region_id
    LEFT JOIN users u ON u.id = rows.updated_by
    WHERE UPPER(TRIM(rows.ticket_id)) = $1
      ${workLocationClause}
    ORDER BY reports.report_date ASC, reports.created_at ASC
  `;

  const result = await query<RcaCaseTimelineEntryDb>(sql, params);
  return result.rows;
}
