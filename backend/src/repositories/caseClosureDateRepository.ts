import type { PoolClient } from "pg";
import { pool, query } from "../config/database.js";

/**
 * Imported case closure dates (from the Flex Closure ASP Report). Keyed by WO id and
 * Case id; a report row is matched by WO id first, then Case id.
 */

export interface CaseClosureDateInput {
  woId: string;
  caseId: string;
  /** YYYY-MM-DD */
  closureDate: string;
}

/** Normalises a lookup key exactly the way both writes and reads must agree on. */
export function normalizeKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * Replaces the whole closure-date set with `rows` in a single transaction, so an import
 * is all-or-nothing and re-importing fully refreshes the data. Rows are upserted by WO id
 * and by Case id independently, so either key can match later.
 */
export async function replaceCaseClosureDates(
  rows: readonly CaseClosureDateInput[],
): Promise<number> {
  // The source report can repeat a WO id / Case id across rows. De-duplicate before
  // insert (last occurrence wins) so a single key never collides with the unique
  // indexes, and drop any later row that reuses a WO id or Case id already taken.
  const seenWo = new Set<string>();
  const seenCase = new Set<string>();
  const deduped: Array<{ woId: string; caseId: string; closureDate: string }> = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const woId = normalizeKey(row.woId);
    const caseId = normalizeKey(row.caseId);
    if (!woId && !caseId) continue; // nothing to match on
    if (woId && seenWo.has(woId)) continue; // WO id already taken by a later row
    if (caseId && seenCase.has(caseId)) continue; // Case id already taken
    if (woId) seenWo.add(woId);
    if (caseId) seenCase.add(caseId);
    deduped.push({ woId, caseId, closureDate: row.closureDate });
  }

  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM case_closure_dates");

    for (const row of deduped) {
      await client.query(
        `INSERT INTO case_closure_dates (wo_id, case_id, closure_date, updated_at)
         VALUES ($1, $2, $3::date, NOW())`,
        [row.woId, row.caseId, row.closureDate],
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

export interface ClosureDateLookup {
  byWoId: Map<string, string>;
  byCaseId: Map<string, string>;
}

/**
 * Loads every closure date into two lookup maps (WO id → date, Case id → date) as
 * DD-MM-YYYY strings, matching the Closed Calls table's date display format.
 */
export async function loadClosureDateLookup(): Promise<ClosureDateLookup> {
  const result = await query<{
    wo_id: string;
    case_id: string;
    closure_date: string;
  }>(
    `SELECT wo_id, case_id, to_char(closure_date, 'DD-MM-YYYY') AS closure_date
     FROM case_closure_dates`,
  );

  const byWoId = new Map<string, string>();
  const byCaseId = new Map<string, string>();
  for (const row of result.rows) {
    if (row.wo_id) byWoId.set(row.wo_id, row.closure_date);
    if (row.case_id) byCaseId.set(row.case_id, row.closure_date);
  }
  return { byWoId, byCaseId };
}

export async function countCaseClosureDates(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM case_closure_dates`,
  );
  return Number(result.rows[0]?.count ?? 0);
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
 * Groups the imported closure dates by ASP region.
 *
 * `case_closure_dates` deliberately stores only the keys and the date — the Flex Closure
 * ASP Report has no usable region column. The region is therefore recovered by tracing
 * each WO id / Case id back to a Work Location, first through OpenCall's own report rows
 * and then, if the raw Flex export has been imported, through that. A key that matches
 * neither is reported as `unmatched` rather than being silently dropped.
 */
export async function summarizeCaseClosureDatesByAsp(
  opts: { dateFrom?: string; dateTo?: string } = {},
): Promise<ClosureDateSummary> {
  const dateFrom = opts.dateFrom ?? "";
  const dateTo = opts.dateTo ?? "";
  const locCte = await buildLocationCteSql();

  // MAX() picks one location per key; a work order does not move between ASPs in
  // practice, so any non-blank value for the key is the right one. The month comes from
  // the closure date itself (the report has no month column of its own). An optional
  // day-precise date range scopes the whole summary (used by the Closed Calls filter).
  const result = await query<{ asp_code: string; month: string; count: string }>(
    `WITH loc AS (
       ${locCte}
     )
     SELECT COALESCE(by_wo.loc, by_case.loc, '')      AS asp_code,
            to_char(closure.closure_date, 'YYYY-MM')  AS month,
            COUNT(*)::TEXT                             AS count
       FROM case_closure_dates closure
       LEFT JOIN loc AS by_wo   ON by_wo.key   = closure.wo_id   AND closure.wo_id   <> ''
       LEFT JOIN loc AS by_case ON by_case.key = closure.case_id AND closure.case_id <> ''
      WHERE ($1 = '' OR closure.closure_date >= $1::date)
        AND ($2 = '' OR closure.closure_date <= $2::date)
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
  closureDate: string;
  aspCode: string;
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
}): Promise<ClosureDateRecordList> {
  const locCte = await buildLocationCteSql();

  const result = await query<{
    wo_id: string;
    case_id: string;
    closure_date: string;
    asp_code: string;
    total_count: string;
  }>(
    `WITH loc AS (
       ${locCte}
     )
     SELECT closure.wo_id,
            closure.case_id,
            to_char(closure.closure_date, 'DD-MM-YYYY')  AS closure_date,
            COALESCE(by_wo.loc, by_case.loc, '')         AS asp_code,
            COUNT(*) OVER()::TEXT                         AS total_count
       FROM case_closure_dates closure
       LEFT JOIN loc AS by_wo   ON by_wo.key   = closure.wo_id   AND closure.wo_id   <> ''
       LEFT JOIN loc AS by_case ON by_case.key = closure.case_id AND closure.case_id <> ''
      WHERE ($1 = '' OR COALESCE(by_wo.loc, by_case.loc, '') = $1)
        AND ($2 = '' OR closure.closure_date >= $2::date)
        AND ($3 = '' OR closure.closure_date <= $3::date)
      ORDER BY closure.closure_date DESC
      LIMIT ${CLOSURE_LIST_LIMIT}`,
    [filter.aspCode, filter.dateFrom, filter.dateTo],
  );

  return {
    rows: result.rows.map((row) => ({
      woId: row.wo_id,
      caseId: row.case_id,
      closureDate: row.closure_date,
      aspCode: row.asp_code,
    })),
    total: Number(result.rows[0]?.total_count ?? 0),
  };
}
