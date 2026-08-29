import type { PoolClient } from "pg";
import { pool, query } from "../config/database.js";
import { CLOSURE_STATUS_MATCHERS } from "../services/closureDates/closureStatusClassify.js";

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
 * Drops rows that would collide on IDENTITY, which is the work order.
 *
 * This used to reject a row whose `case_id` was already taken, because 029 made case_id
 * UNIQUE as well. The vendor's data does not work that way: a customer who calls back
 * gets a NEW work order on the SAME case, and Flex closes that one too. Measured on prod
 * for one bill cycle, that rule silently discarded 19 completed, billable closures —
 * every one "WO Closed" with a valid closure date, rejected only for sharing a case.
 * Migration 065 drops the index; this is the code half of the same fix.
 *
 * A row carrying no work order at all still falls back to its case id — that is the only
 * identity it has, so two such rows on one case genuinely cannot be told apart.
 */
function dedupeByWorkOrder(
  rows: readonly CaseClosureRecordInput[],
): CaseClosureRecordInput[] {
  const seenWo = new Set<string>();
  const seenCaseWithoutWo = new Set<string>();
  const deduped: CaseClosureRecordInput[] = [];

  for (const row of rows) {
    const woId = normalizeKey(row.woId);
    const caseId = normalizeKey(row.caseId);
    if (!woId && !caseId) continue; // nothing to match on
    if (woId) {
      if (seenWo.has(woId)) continue;
      seenWo.add(woId);
    } else {
      if (seenCaseWithoutWo.has(caseId)) continue;
      seenCaseWithoutWo.add(caseId);
    }
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
  const deduped = dedupeByWorkOrder(rows);

  // NEVER wipe the table for an empty batch. The DELETE below is unconditional, so an
  // import whose file parsed to no usable rows — a headers-only morning export, a
  // truncated download, a workbook with unexpected column names — used to destroy the
  // entire closure history and replace it with nothing. Callers surface this as an
  // error; here we simply refuse to touch the table.
  if (deduped.length === 0) {
    return 0;
  }

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
 * Shape: key-scoped delete, then insert, keyed on IDENTITY — the work order.
 *
 * The delete used to be scoped by case_id as well, because 029 made that unique too and
 * a stale row holding this batch's case would have broken the insert. Migration 065
 * removed that index, and keeping the case-scoped delete would now be actively
 * destructive: with several work orders legitimately on one case, an import carrying
 * WO-A would delete its sibling WO-B — closed weeks earlier, outside this file's range —
 * and never insert it back. That is exactly the shape of a rolling-window sync.
 */
export async function mergeCaseClosureDates(
  rows: readonly CaseClosureRecordInput[],
): Promise<number> {
  const deduped = dedupeByWorkOrder(rows);
  if (deduped.length === 0) return 0;

  const woIds = deduped.filter((row) => row.woId !== "").map((row) => row.woId);
  // Only rows that have NO work order of their own are matched by case. Deleting every
  // stored row sharing a case would be destructive now that a case legitimately carries
  // several work orders: a rolling import holding WO-A would delete its sibling WO-B —
  // closed weeks earlier and outside this file's range — and never put it back.
  const keylessCaseIds = deduped
    .filter((row) => row.woId === "" && row.caseId !== "")
    .map((row) => row.caseId);

  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM case_closure_dates
        WHERE (wo_id <> '' AND wo_id = ANY($1::text[]))
           OR (wo_id  = '' AND case_id <> '' AND case_id = ANY($2::text[]))`,
      [woIds, keylessCaseIds],
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
  // How many closures each case carries. Since 065 a case may hold several, and the
  // Case-id fallback then has no way to tell which one a row means — the old
  // last-write-wins picked whichever the query happened to return last. An ambiguous
  // case is dropped from the fallback entirely: a row whose own WO id matches still
  // resolves exactly, and a row that only matches by case gets nothing rather than a
  // coin-flip closure. Guessing here is what stamped a Vellore row with a Kanchipuram
  // closure.
  const caseCounts = new Map<string, number>();
  for (const row of result.rows) {
    if (row.case_id) {
      caseCounts.set(row.case_id, (caseCounts.get(row.case_id) ?? 0) + 1);
    }
  }
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
    if (row.case_id && caseCounts.get(row.case_id) === 1) {
      byCaseId.set(row.case_id, record);
    }
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
  /**
   * ISO instant of the most recent import RUN — even one that imported 0 rows (an empty
   * new-day export). This is the liveness signal; `lastImportedAt` only moves when a run
   * actually wrote rows, which every morning is hours later than the last healthy run.
   * Null until migration 042 is applied or before the first recorded run.
   */
  lastSyncAt: string | null;
  /** 'AUTO' / 'MANUAL' — the source of that most recent run. */
  lastSyncSource: string | null;
  /** Work orders that run imported (0 for an empty export). */
  lastSyncImported: number | null;
}

/** Migration 042 may not be applied yet — every reader/writer of the run log checks. */
async function closureSyncRunsTablePresent(): Promise<boolean> {
  const result = await query<{ present: boolean }>(
    `SELECT to_regclass('public.closure_sync_runs') IS NOT NULL AS present`,
  );
  return result.rows[0]?.present ?? false;
}

/**
 * Record one closure import run. Best-effort by design: the import itself must never
 * fail because the freshness bookkeeping did, so callers fire-and-forget this and a
 * missing table (migration 042 not yet applied) is simply a no-op.
 */
export async function recordClosureSyncRun(input: {
  source: string;
  mode: string;
  totalRows: number;
  imported: number;
}): Promise<void> {
  try {
    if (!(await closureSyncRunsTablePresent())) return;
    await query(
      `INSERT INTO closure_sync_runs (source, mode, total_rows, imported)
       VALUES ($1, $2, $3, $4)`,
      [input.source, input.mode, input.totalRows, input.imported],
    );
    // The auto-sync runs ~96 times a day; without pruning this log accumulates forever
    // (cf. the closed-call ledger). 90 days is far more history than the badge needs.
    await query(
      `DELETE FROM closure_sync_runs WHERE ran_at < NOW() - INTERVAL '90 days'`,
    );
  } catch (error) {
    console.warn("[ClosureDates] could not record sync run:", error);
  }
}

interface LastClosureSyncRun {
  ranAt: string;
  source: string;
  imported: number;
}

async function getLastClosureSyncRun(): Promise<LastClosureSyncRun | null> {
  if (!(await closureSyncRunsTablePresent())) return null;
  const result = await query<{
    ran_at: string;
    source: string;
    imported: number;
  }>(
    `SELECT to_char(ran_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ran_at,
            source,
            imported
       FROM closure_sync_runs
      ORDER BY ran_at DESC, id DESC
      LIMIT 1`,
  );
  const row = result.rows[0];
  return row
    ? { ranAt: row.ran_at, source: row.source, imported: Number(row.imported) }
    : null;
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
  const lastRun = await getLastClosureSyncRun();
  return {
    count: Number(row?.count ?? 0),
    lastImportedAt: row?.last_imported_at ?? null,
    lastImportSource: row?.last_import_source ?? null,
    lastClosedOn: row?.last_closed_on ?? null,
    lastSyncAt: lastRun?.ranAt ?? null,
    lastSyncSource: lastRun?.source ?? null,
    lastSyncImported: lastRun?.imported ?? null,
  };
}

export interface ClosureDateAspCount {
  aspCode: string;
  count: number;
  /** Of `count`, the genuine completions — "WO Closed" and friends. */
  closed: number;
  /** Of `count`, the "Closed - Canceled" rows. Abandoned calls, never billable. */
  cancelled: number;
  /** Of `count`, everything else (incl. a blank Status). */
  other: number;
}

export interface ClosureDateAspMonthCount extends ClosureDateAspCount {
  /** '' means the "All months" rollup for that ASP. */
  month: string;
}

export interface ClosureDateSummary {
  /** Every stored closure date, matched or not. */
  total: number;
  /** Of `total`, the genuine completions. This is what the Closed Calls card shows. */
  closed: number;
  /** Of `total`, the cancellations. */
  cancelled: number;
  /** Of `total`, the unclassifiable remainder. */
  other: number;
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
 * `classifyClosureStatus` expressed in SQL, so a summary can be grouped without pulling
 * every row into Node. Generated from the SAME ordered matcher list the TS classifier
 * walks, so the two cannot drift.
 *
 * ORDER MATTERS: the literal "Closed - Canceled" contains BOTH words, so CANCEL is
 * tested before CLOSE. A CASE evaluates its WHENs in order, which is why the list maps
 * onto it directly. Substrings are rule constants, never user input.
 */
function closureStatusGroupSql(column = "closure.closure_status"): string {
  return `CASE
       ${CLOSURE_STATUS_MATCHERS.map(
         (m) =>
           `WHEN UPPER(COALESCE(${column}, '')) LIKE '%${m.substring}%' THEN '${m.group}'`,
       ).join("\n       ")}
       ELSE 'other'
     END`;
}

const CLOSURE_STATUS_GROUP_SQL = closureStatusGroupSql();

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
  //
  // The outcome split is computed here rather than filtered here: the card shows
  // completions but the cancellations have to stay visible beside them, and `total`
  // remains every stored closure so nothing silently disappears from the page.
  const result = await query<{
    asp_code: string;
    month: string;
    count: string;
    closed: string;
    cancelled: string;
    other: string;
  }>(
    `WITH loc AS (
       ${locCte}
     )
     SELECT ${CLOSURE_ASP_CODE_SQL}                 AS asp_code,
            to_char(closure.closed_on, 'YYYY-MM')   AS month,
            COUNT(*)::TEXT                          AS count,
            COUNT(*) FILTER (WHERE ${CLOSURE_STATUS_GROUP_SQL} = 'closed')::TEXT
                                                    AS closed,
            COUNT(*) FILTER (WHERE ${CLOSURE_STATUS_GROUP_SQL} = 'cancelled')::TEXT
                                                    AS cancelled,
            COUNT(*) FILTER (WHERE ${CLOSURE_STATUS_GROUP_SQL} = 'other')::TEXT
                                                    AS other
       FROM case_closure_dates closure
       LEFT JOIN loc AS by_wo   ON by_wo.key   = closure.wo_id   AND closure.wo_id   <> ''
       LEFT JOIN loc AS by_case ON by_case.key = closure.case_id AND closure.case_id <> ''
      WHERE ($1 = '' OR closure.closed_on >= $1::date)
        AND ($2 = '' OR closure.closed_on <= $2::date)
      GROUP BY 1, 2`,
    [dateFrom, dateTo],
  );

  const byAspMonth: ClosureDateAspMonthCount[] = [];
  const aspRollup = new Map<string, ClosureDateAspCount>();
  const monthSet = new Set<string>();
  let unmatched = 0;
  let total = 0;
  let closedTotal = 0;
  let cancelledTotal = 0;
  let otherTotal = 0;

  for (const row of result.rows) {
    const count = Number(row.count);
    const closed = Number(row.closed);
    const cancelled = Number(row.cancelled);
    const other = Number(row.other);
    total += count;
    closedTotal += closed;
    cancelledTotal += cancelled;
    otherTotal += other;
    if (row.month) monthSet.add(row.month);
    // Unmatched rows (no region) are still kept in byAspMonth under aspCode '' so the
    // "All Regions" month total stays complete; they just never land on a region card.
    byAspMonth.push({
      aspCode: row.asp_code,
      month: row.month,
      count,
      closed,
      cancelled,
      other,
    });
    if (!row.asp_code) {
      unmatched += count;
      continue;
    }
    const entry = aspRollup.get(row.asp_code) ?? {
      aspCode: row.asp_code,
      count: 0,
      closed: 0,
      cancelled: 0,
      other: 0,
    };
    entry.count += count;
    entry.closed += closed;
    entry.cancelled += cancelled;
    entry.other += other;
    aspRollup.set(row.asp_code, entry);
  }

  const byAsp: ClosureDateAspCount[] = [...aspRollup.values()].sort(
    (a, b) => b.count - a.count,
  );

  return {
    total,
    closed: closedTotal,
    cancelled: cancelledTotal,
    other: otherTotal,
    unmatched,
    byAsp,
    byAspMonth,
    months: [...monthSet].sort(),
  };
}

/**
 * How soon a second visit to the same case counts as a callback rather than new work.
 *
 * HP does not pay for a case reopened within this many days of its last closure: the
 * work order differs but the case is the same, so the second visit is unpaid. Fifteen
 * days is the vendor's rule, not ours — it belongs here as a named constant so the API,
 * the card totals and any future report all read the same number.
 */
export const REPEAT_VISIT_WINDOW_DAYS = 15;

/** One closure, positioned against the previous closure on the same case. */
export interface RepeatVisitRow {
  woId: string;
  caseId: string;
  aspCode: string;
  /** YYYY-MM-DD. */
  closedOn: string;
  status: string;
  /** The closure this one followed on the same case, or '' when it is the first. */
  previousWoId: string;
  /** YYYY-MM-DD of that previous closure, or ''. */
  previousClosedOn: string;
  /** Days since the previous closure on this case, or null when there is none. */
  gapDays: number | null;
  /** True when this visit falls inside the window and so is not billable. */
  unpaid: boolean;
}

export interface RepeatVisitSummary {
  windowDays: number;
  /** Completed closures in range — what the card headlines. */
  closed: number;
  /** Of those, repeat visits inside the window. Not billable. */
  unpaid: number;
  /** closed - unpaid. */
  payable: number;
  byAsp: Array<{ aspCode: string; closed: number; unpaid: number; payable: number }>;
  /** Every unpaid visit, newest first. */
  rows: RepeatVisitRow[];
}

/**
 * Repeat visits: a case closed again within `REPEAT_VISIT_WINDOW_DAYS` of its previous
 * closure, which HP does not pay for.
 *
 * The LAG runs over EVERY stored closure, not just the ones in range, then the range
 * filter is applied afterwards. That ordering matters: a visit on 26 July whose original
 * closed on 20 July is unpaid, and a query that only ever saw the range would call it a
 * first closure and count it as billable.
 *
 * Cancellations are excluded from the sequence entirely — a cancelled call is not a
 * visit, so a completion following one is genuine first-fix work, not a callback.
 */
export async function summarizeRepeatVisits(opts: {
  dateFrom: string;
  dateTo: string;
  allowedAspCodes?: string[] | null;
}): Promise<RepeatVisitSummary> {
  const result = await query<{
    wo_id: string;
    case_id: string;
    asp_code: string;
    closed_on: string;
    closure_status: string | null;
    prev_wo_id: string | null;
    prev_closed_on: string | null;
    gap_days: string | null;
  }>(
    `WITH completed AS (
       SELECT wo_id, case_id,
              UPPER(TRIM(COALESCE(work_location, ''))) AS asp_code,
              closed_on, closure_status
         FROM case_closure_dates
        WHERE closed_on IS NOT NULL
          AND ${closureStatusGroupSql("closure_status")} = 'closed'
     ),
     seq AS (
       SELECT c.*,
              LAG(c.wo_id)     OVER w AS prev_wo_id,
              LAG(c.closed_on) OVER w AS prev_closed_on
         FROM completed c
        WHERE c.case_id <> ''
       WINDOW w AS (PARTITION BY c.case_id ORDER BY c.closed_on, c.wo_id)
     )
     SELECT wo_id, case_id, asp_code,
            to_char(closed_on, 'YYYY-MM-DD')      AS closed_on,
            closure_status,
            COALESCE(prev_wo_id, '')              AS prev_wo_id,
            to_char(prev_closed_on, 'YYYY-MM-DD') AS prev_closed_on,
            (closed_on - prev_closed_on)::TEXT    AS gap_days
       FROM seq
      WHERE closed_on BETWEEN $1::date AND $2::date
        AND ($3::text[] IS NULL OR asp_code = ANY($3::text[]))
      ORDER BY closed_on DESC, wo_id`,
    [opts.dateFrom, opts.dateTo, opts.allowedAspCodes ?? null],
  );

  const rows: RepeatVisitRow[] = [];
  const byAsp = new Map<string, { closed: number; unpaid: number }>();
  let closed = 0;
  let unpaid = 0;

  for (const row of result.rows) {
    const gapDays = row.gap_days === null ? null : Number(row.gap_days);
    const isUnpaid = gapDays !== null && gapDays <= REPEAT_VISIT_WINDOW_DAYS;
    closed += 1;
    const entry = byAsp.get(row.asp_code) ?? { closed: 0, unpaid: 0 };
    entry.closed += 1;
    if (isUnpaid) {
      unpaid += 1;
      entry.unpaid += 1;
      rows.push({
        woId: row.wo_id,
        caseId: row.case_id,
        aspCode: row.asp_code,
        closedOn: row.closed_on,
        status: row.closure_status ?? "",
        previousWoId: row.prev_wo_id ?? "",
        previousClosedOn: row.prev_closed_on ?? "",
        gapDays,
        unpaid: true,
      });
    }
    byAsp.set(row.asp_code, entry);
  }

  return {
    windowDays: REPEAT_VISIT_WINDOW_DAYS,
    closed,
    unpaid,
    payable: closed - unpaid,
    byAsp: [...byAsp.entries()]
      .map(([aspCode, e]) => ({
        aspCode,
        closed: e.closed,
        unpaid: e.unpaid,
        payable: e.closed - e.unpaid,
      }))
      .sort((a, b) => b.closed - a.closed),
    rows,
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
   * 'closed' / 'cancelled' / 'other' to match one half of the card's split, or '' for
   * every closure. Classified by the same rule as the summary, so a drill-down can
   * never return a different set of rows than the number that opened it.
   */
  statusGroup?: string;
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
        AND ($5 = '' OR ${CLOSURE_STATUS_GROUP_SQL} = $5)
      ORDER BY closure.closed_on DESC
      LIMIT ${CLOSURE_LIST_LIMIT}`,
    [
      filter.aspCode,
      filter.dateFrom,
      filter.dateTo,
      filter.allowedAspCodes ?? null,
      filter.statusGroup ?? "",
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
