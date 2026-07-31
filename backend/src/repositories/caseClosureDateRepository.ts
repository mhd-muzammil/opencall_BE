import type { PoolClient } from "pg";
import { pool, query } from "../config/database.js";

/**
 * Imported case closure dates (from the Flex Closure ASP Report). Keyed by WO id and
 * Case id; a report row is matched by WO id first, then Case id.
 */

/**
 * One work order's closure, as read from the Flex Closure ASP Report. Everything past
 * the two keys is verbatim vendor data; nothing here is derived by OpenCall.
 */
export interface CaseClosureRecordInput {
  woId: string;
  caseId: string;
  /** YYYY-MM-DD, or null — a "Closed - Canceled" row has no closure date. */
  closureDate: string | null;
  /** YYYY-MM-DD the closure is counted under: closureDate, else the Activity Time day. */
  closedOn: string | null;
  closureStatus: string;
  statusRemarks: string;
  failureCode: string;
  resolutionComments: string;
  workLocation: string;
  aspName: string;
  /** ISO-8601 with an explicit offset, or null. */
  activityTime: string | null;
  /** 'MANUAL' (the import button) or 'AUTO' (the FieldEZ worker). */
  importSource: string;
}

/** Normalises a lookup key exactly the way both writes and reads must agree on. */
export function normalizeKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

const INSERT_COLUMNS = `(wo_id, case_id, closure_date, closed_on, closure_status,
     status_remarks, failure_code, resolution_comments, work_location, asp_name,
     activity_time, import_source, imported_at, updated_at)`;

const INSERT_VALUES = `($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10,
     $11::timestamptz, $12, NOW(), NOW())`;

function insertParams(row: CaseClosureRecordInput): unknown[] {
  return [
    normalizeKey(row.woId),
    normalizeKey(row.caseId),
    row.closureDate,
    row.closedOn,
    row.closureStatus,
    row.statusRemarks,
    row.failureCode,
    row.resolutionComments,
    row.workLocation,
    row.aspName,
    row.activityTime,
    row.importSource,
  ];
}

/**
 * Drops rows that would collide with either partial unique index. The table has TWO
 * (`wo_id` and `case_id`), so a row is only insertable when BOTH of its non-blank keys
 * are still free. First occurrence wins — the parser has already chosen the best row per
 * work order, so anything reaching here is a genuine cross-key clash.
 */
function dedupeByBothKeys(
  rows: readonly CaseClosureRecordInput[],
): CaseClosureRecordInput[] {
  const seenWo = new Set<string>();
  const seenCase = new Set<string>();
  const deduped: CaseClosureRecordInput[] = [];

  for (const row of rows) {
    const woId = normalizeKey(row.woId);
    const caseId = normalizeKey(row.caseId);
    if (!woId && !caseId) continue; // nothing to match on
    if (woId && seenWo.has(woId)) continue;
    if (caseId && seenCase.has(caseId)) continue;
    if (woId) seenWo.add(woId);
    if (caseId) seenCase.add(caseId);
    deduped.push({ ...row, woId, caseId });
  }

  return deduped;
}

/**
 * Replaces the whole closure set with `rows` in a single transaction, so an import is
 * all-or-nothing and re-importing fully refreshes the data.
 *
 * This is the MANUAL import's behaviour and is deliberately unchanged. The hourly
 * auto-sync must never come through here — it carries only today's keys, and the
 * unconditional DELETE would throw every earlier day away.
 */
export async function replaceCaseClosureDates(
  rows: readonly CaseClosureRecordInput[],
): Promise<number> {
  const deduped = dedupeByBothKeys(rows);

  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM case_closure_dates");

    for (const row of deduped) {
      await client.query(
        `INSERT INTO case_closure_dates ${INSERT_COLUMNS} VALUES ${INSERT_VALUES}`,
        insertParams(row),
      );
    }

    await client.query("COMMIT");
    return deduped.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Merges `rows` into the stored set, touching ONLY the keys present in this batch —
 * every other stored closure, from every earlier day, is left alone. This is what the
 * hourly today-only auto-sync uses.
 *
 * Shape: key-scoped delete, then insert. Not `ON CONFLICT`, because the table carries
 * two partial unique indexes (`wo_id` and `case_id`) and a single conflict target cannot
 * cover both. The delete is scoped by BOTH key sets — scoping by `wo_id` alone would
 * leave a stale row holding this batch's `case_id` and the insert would violate
 * `case_closure_dates_case_id_uidx`.
 */
export async function mergeCaseClosureDates(
  rows: readonly CaseClosureRecordInput[],
): Promise<number> {
  const deduped = dedupeByBothKeys(rows);
  if (deduped.length === 0) return 0;

  const woIds = deduped.map((row) => row.woId).filter((id) => id !== "");
  const caseIds = deduped.map((row) => row.caseId).filter((id) => id !== "");

  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM case_closure_dates
        WHERE (wo_id   <> '' AND wo_id   = ANY($1::text[]))
           OR (case_id <> '' AND case_id = ANY($2::text[]))`,
      [woIds, caseIds],
    );

    for (const row of deduped) {
      await client.query(
        `INSERT INTO case_closure_dates ${INSERT_COLUMNS} VALUES ${INSERT_VALUES}`,
        insertParams(row),
      );
    }

    await client.query("COMMIT");
    return deduped.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A stored closure, as the report enricher needs it. */
export interface ClosureRecord {
  woId: string;
  caseId: string;
  /** DD-MM-YYYY (the Closed Calls table's display format), or '' when there is none. */
  closureDate: string;
  /** DD-MM-YYYY. */
  closedOn: string;
  /** YYYY-MM-DD — for date comparisons rather than display. */
  closedOnIso: string;
  status: string;
  statusRemarks: string;
  failureCode: string;
  workLocation: string;
}

export interface ClosureDateLookup {
  byWoId: Map<string, ClosureRecord>;
  byCaseId: Map<string, ClosureRecord>;
}

/**
 * Loads every stored closure into two lookup maps (WO id → record, Case id → record).
 * Dates come back pre-formatted DD-MM-YYYY to match the Closed Calls table.
 */
export async function loadClosureDateLookup(): Promise<ClosureDateLookup> {
  const result = await query<{
    wo_id: string;
    case_id: string;
    closure_date: string | null;
    closed_on: string | null;
    closed_on_iso: string | null;
    closure_status: string | null;
    status_remarks: string | null;
    failure_code: string | null;
    work_location: string | null;
  }>(
    `SELECT wo_id,
            case_id,
            to_char(closure_date, 'DD-MM-YYYY')  AS closure_date,
            to_char(closed_on,    'DD-MM-YYYY')  AS closed_on,
            to_char(closed_on,    'YYYY-MM-DD')  AS closed_on_iso,
            closure_status,
            status_remarks,
            failure_code,
            work_location
       FROM case_closure_dates`,
  );

  const byWoId = new Map<string, ClosureRecord>();
  const byCaseId = new Map<string, ClosureRecord>();
  for (const row of result.rows) {
    const record: ClosureRecord = {
      woId: row.wo_id,
      caseId: row.case_id,
      closureDate: row.closure_date ?? "",
      closedOn: row.closed_on ?? "",
      closedOnIso: row.closed_on_iso ?? "",
      status: row.closure_status ?? "",
      statusRemarks: row.status_remarks ?? "",
      failureCode: row.failure_code ?? "",
      workLocation: row.work_location ?? "",
    };
    if (row.wo_id) byWoId.set(row.wo_id, record);
    if (row.case_id) byCaseId.set(row.case_id, record);
  }
  return { byWoId, byCaseId };
}

export interface ClosureImportStatus {
  count: number;
  /** ISO instant of the most recent import of any row, or null when the table is empty. */
  lastImportedAt: string | null;
  /** 'AUTO' / 'MANUAL' — the source of that most recent row. */
  lastImportSource: string | null;
  /** YYYY-MM-DD of the latest closure day stored. */
  lastClosedOn: string | null;
}

/**
 * Freshness of the closure data, for the Closed Calls status line. `lastImportedAt` is
 * what turns that line red: a worker that has silently died keeps serving yesterday's
 * statuses while the row count still looks perfectly healthy.
 */
export async function getClosureImportStatus(): Promise<ClosureImportStatus> {
  const result = await query<{
    count: string;
    last_imported_at: string | null;
    last_import_source: string | null;
    last_closed_on: string | null;
  }>(
    `SELECT COUNT(*)::TEXT                                AS count,
            to_char(MAX(imported_at) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"')          AS last_imported_at,
            (SELECT import_source FROM case_closure_dates
              ORDER BY imported_at DESC NULLS LAST LIMIT 1) AS last_import_source,
            to_char(MAX(closed_on), 'YYYY-MM-DD')           AS last_closed_on
       FROM case_closure_dates`,
  );

  const row = result.rows[0];
  return {
    count: Number(row?.count ?? 0),
    lastImportedAt: row?.last_imported_at ?? null,
    lastImportSource: row?.last_import_source ?? null,
    lastClosedOn: row?.last_closed_on ?? null,
  };
}

export interface ClosureDateAspCount {
  aspCode: string;
  count: number;
}

export interface ClosureDateAspMonthCount extends ClosureDateAspCount {
  /** '' means the "All months" rollup for that ASP. */
  month: string;
}

export interface ClosureDateSummary {
  /** Every stored closure date, matched or not. */
  total: number;
  /** Rows whose WO id / Case id could not be traced to a Work Location. */
  unmatched: number;
  /** Per Work Location, all months, biggest first. */
  byAsp: ClosureDateAspCount[];
  /** Per Work Location per month, so the card counts can be scoped to one month. */
  byAspMonth: ClosureDateAspMonthCount[];
  /** Distinct months present, ascending ("YYYY-MM"). */
  months: string[];
}

/** True when the table exists — lets a query stay safe before its migration has run. */
async function tableExists(name: string): Promise<boolean> {
  const result = await query<{ reg: string | null }>(
    `SELECT to_regclass($1)::TEXT AS reg`,
    [`public.${name}`],
  );
  return Boolean(result.rows[0]?.reg);
}

/**
 * SQL for the `loc` CTE mapping a normalised WO id / Case id key to its Work Location,
 * traced through the report rows and (when imported) the raw Flex export. Shared by the
 * region summary and the per-region record list so they can never diverge.
 */
async function buildLocationCteSql(): Promise<string> {
  const hasRawRecords = await tableExists("flex_raw_records");
  const lookupSources = [
    `SELECT UPPER(TRIM(ticket_id)) AS key, UPPER(TRIM(work_location)) AS loc
       FROM daily_call_plan_report_rows
      WHERE COALESCE(TRIM(ticket_id), '') <> ''
        AND COALESCE(TRIM(work_location), '') <> ''`,
    `SELECT UPPER(TRIM(case_id)) AS key, UPPER(TRIM(work_location)) AS loc
       FROM daily_call_plan_report_rows
      WHERE COALESCE(TRIM(case_id), '') <> ''
        AND COALESCE(TRIM(work_location), '') <> ''`,
  ];
  if (hasRawRecords) {
    lookupSources.push(
      `SELECT ticket_no AS key, work_location AS loc
         FROM flex_raw_records
        WHERE ticket_no <> '' AND work_location <> ''`,
      `SELECT case_id AS key, work_location AS loc
         FROM flex_raw_records
        WHERE case_id <> '' AND work_location <> ''`,
    );
  }
  return `SELECT key, MAX(loc) AS loc
            FROM (${lookupSources.join("\n              UNION ALL\n")}) sources
           GROUP BY key`;
}

/**
 * The ASP code for a stored closure. The file's own Work Location is authoritative when
 * present (041 stores it); the traced lookup stays as the fallback for rows imported
 * before that column existed. This is what drives `unmatched` towards zero.
 */
const CLOSURE_ASP_CODE_SQL = `COALESCE(NULLIF(closure.work_location, ''), by_wo.loc, by_case.loc, '')`;

/**
 * Groups the imported closures by ASP region.
 *
 * The Flex Closure ASP Report has no region column of its own, but it does carry Work
 * Location, which 041 stores. For rows imported before that, the region is recovered by
 * tracing the WO id / Case id back to a Work Location through OpenCall's own report rows
 * and, when imported, the raw Flex export. A key that matches nothing is reported as
 * `unmatched` rather than being silently dropped.
 *
 * Grouping and filtering key off `closed_on`, not `closure_date`: a "Closed - Canceled"
 * row has no closure date but is still a closure and must not vanish from the counts.
 */
export async function summarizeCaseClosureDatesByAsp(
  opts: { dateFrom?: string; dateTo?: string } = {},
): Promise<ClosureDateSummary> {
  const dateFrom = opts.dateFrom ?? "";
  const dateTo = opts.dateTo ?? "";
  const locCte = await buildLocationCteSql();

  // MAX() picks one location per key; a work order does not move between ASPs in
  // practice, so any non-blank value for the key is the right one. An optional
  // day-precise date range scopes the whole summary (used by the Closed Calls filter).
  const result = await query<{ asp_code: string; month: string; count: string }>(
    `WITH loc AS (
       ${locCte}
     )
     SELECT ${CLOSURE_ASP_CODE_SQL}                 AS asp_code,
            to_char(closure.closed_on, 'YYYY-MM')   AS month,
            COUNT(*)::TEXT                          AS count
       FROM case_closure_dates closure
       LEFT JOIN loc AS by_wo   ON by_wo.key   = closure.wo_id   AND closure.wo_id   <> ''
       LEFT JOIN loc AS by_case ON by_case.key = closure.case_id AND closure.case_id <> ''
      WHERE ($1 = '' OR closure.closed_on >= $1::date)
        AND ($2 = '' OR closure.closed_on <= $2::date)
      GROUP BY 1, 2`,
    [dateFrom, dateTo],
  );

  const byAspMonth: ClosureDateAspMonthCount[] = [];
  const aspRollup = new Map<string, number>();
  const monthSet = new Set<string>();
  let unmatched = 0;
  let total = 0;

  for (const row of result.rows) {
    const count = Number(row.count);
    total += count;
    if (row.month) monthSet.add(row.month);
    // Unmatched rows (no region) are still kept in byAspMonth under aspCode '' so the
    // "All Regions" month total stays complete; they just never land on a region card.
    byAspMonth.push({ aspCode: row.asp_code, month: row.month, count });
    if (!row.asp_code) {
      unmatched += count;
      continue;
    }
    aspRollup.set(row.asp_code, (aspRollup.get(row.asp_code) ?? 0) + count);
  }

  const byAsp: ClosureDateAspCount[] = [...aspRollup.entries()]
    .map(([aspCode, count]) => ({ aspCode, count }))
    .sort((a, b) => b.count - a.count);

  return {
    total,
    unmatched,
    byAsp,
    byAspMonth,
    months: [...monthSet].sort(),
  };
}

export interface ClosureDateRecordRow {
  woId: string;
  caseId: string;
  /** DD-MM-YYYY, or '' for a cancellation Flex closed without a closure date. */
  closureDate: string;
  aspCode: string;
  /** The vendor's own status, so a blank closure date is explainable in the drill-down. */
  closureStatus: string;
}

export interface ClosureDateRecordList {
  rows: ClosureDateRecordRow[];
  total: number;
}

const CLOSURE_LIST_LIMIT = 2000;

/**
 * The individual closure dates behind a region card's "Closure import" count — filtered
 * by the recovered ASP ('' = every region, including unmatched) and a day-precise date
 * range (both '' = every date). Capped; `total` is the true count.
 */
export async function listCaseClosureDatesForAsp(filter: {
  aspCode: string;
  dateFrom: string;
  dateTo: string;
  /**
   * ASP codes the caller may read, or `null` for unrestricted. Enforced here as well
   * as in the controller so an empty `aspCode` ("every region", which also includes
   * rows that matched no region) can never widen a region-scoped principal's view.
   */
  allowedAspCodes?: string[] | null;
}): Promise<ClosureDateRecordList> {
  const locCte = await buildLocationCteSql();

  const result = await query<{
    wo_id: string;
    case_id: string;
    closure_date: string | null;
    closure_status: string | null;
    asp_code: string;
    total_count: string;
  }>(
    `WITH loc AS (
       ${locCte}
     )
     SELECT closure.wo_id,
            closure.case_id,
            to_char(closure.closure_date, 'DD-MM-YYYY')  AS closure_date,
            closure.closure_status,
            ${CLOSURE_ASP_CODE_SQL}                      AS asp_code,
            COUNT(*) OVER()::TEXT                         AS total_count
       FROM case_closure_dates closure
       LEFT JOIN loc AS by_wo   ON by_wo.key   = closure.wo_id   AND closure.wo_id   <> ''
       LEFT JOIN loc AS by_case ON by_case.key = closure.case_id AND closure.case_id <> ''
      WHERE ($1 = '' OR ${CLOSURE_ASP_CODE_SQL} = $1)
        AND ($4::text[] IS NULL
             OR ${CLOSURE_ASP_CODE_SQL} = ANY($4::text[]))
        AND ($2 = '' OR closure.closed_on >= $2::date)
        AND ($3 = '' OR closure.closed_on <= $3::date)
      ORDER BY closure.closed_on DESC
      LIMIT ${CLOSURE_LIST_LIMIT}`,
    [
      filter.aspCode,
      filter.dateFrom,
      filter.dateTo,
      filter.allowedAspCodes ?? null,
    ],
  );

  return {
    rows: result.rows.map((row) => ({
      woId: row.wo_id,
      caseId: row.case_id,
      closureDate: row.closure_date ?? "",
      aspCode: row.asp_code,
      closureStatus: row.closure_status ?? "",
    })),
    total: Number(result.rows[0]?.total_count ?? 0),
  };
}
