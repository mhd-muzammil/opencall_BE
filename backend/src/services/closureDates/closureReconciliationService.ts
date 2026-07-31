import { query } from "../../config/database.js";
import { normalizeKey } from "../../repositories/caseClosureDateRepository.js";

/**
 * "Did Flex agree with us today?" — compares the calls the team closed on the Open Call
 * Report against the closures Flex actually reported, for one report date.
 *
 * Nothing here mutates anything. The output is a reconciliation aid: humans decide what
 * to do about a disagreement.
 */

// ---------------------------------------------------------------- the closed set

/**
 * RTPL statuses that mean "we closed this call". Genuine completions only — the same set
 * `classifyProductivityStatus` treats as CLOSED. Cancellations ("Closed-cancellation")
 * and intents ("Need to Close") are attended work, not a completed close, so a
 * cancellation showing up only on the Flex side is not counted as our disagreement.
 *
 * Tokens, not exact labels, because real data carries every spelling of these two:
 * "Case-Closed", "Case Closed", "WO-closed", "wo closed".
 */
export const CLOSED_HERE_STATUS_TOKENS: readonly string[] = ["case close", "wo close"];

function normalizeStatus(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

const MANUAL_PLACEHOLDER = "manual entry required";

/** True when this evening-first status means the team closed the call. */
export function isClosedHereStatus(value: unknown): boolean {
  const normalized = normalizeStatus(value);
  if (!normalized) return false;
  return CLOSED_HERE_STATUS_TOKENS.some((token) => normalized.includes(token));
}

export interface StatusSource {
  rtplStatus: string | null;
  previousRtplStatus: string | null;
  eveningRtplStatus: string | null;
}

/**
 * The status the "RTPL HOURES STATUS" tiles count a row under, mirrored VERBATIM from
 * the frontend's `rtplEveningFirstStatusForAnalytics`: the Evening entry once one exists
 * and is not a placeholder, otherwise the Morning-derived status (which itself falls back
 * to the previous day's value when Morning is blank or a placeholder).
 *
 * Deliberately NOT `same_day_closed` — that flag means "the ticket vanished from the Flex
 * WIP", which is a different question from "the team marked it closed".
 */
export function eveningFirstStatus(row: StatusSource): string {
  const evening = String(row.eveningRtplStatus ?? "").trim();
  if (evening && normalizeStatus(evening) !== MANUAL_PLACEHOLDER) {
    return evening;
  }
  const current = String(row.rtplStatus ?? "").trim();
  if (current && normalizeStatus(current) !== MANUAL_PLACEHOLDER) {
    return current;
  }
  return String(row.previousRtplStatus ?? "").trim() || current;
}

// -------------------------------------------------------------------- the buckets

export interface ClosedHereRow extends StatusSource {
  ticketId: string;
  caseId: string;
  aspCode: string;
  /** ISO instant we recorded the close at, or null when unknown. */
  closedAt: string | null;
}

export interface FlexClosureRow {
  woId: string;
  caseId: string;
  aspCode: string;
  status: string;
  /** DD-MM-YYYY, or '' for a cancellation Flex closed without a closure date. */
  closureDate: string;
}

export interface ReconciliationRow {
  ticketId: string;
  caseId: string;
  aspCode: string;
  /** The evening-first RTPL status we closed it under ('' when only Flex closed it). */
  rtplStatus: string;
  /** Flex's own status ('' when Flex has no closure for the day). */
  closureStatus: string;
  closureDate: string;
  /** Hours since we recorded the close — how long Flex has been behind us. */
  hoursSinceClosedHere: number | null;
}

export interface ClosureReconciliation {
  date: string;
  /** Closed on both sides. */
  matched: ReconciliationRow[];
  /** We closed it; Flex has no closure for this day. */
  closedHereNotInFlex: ReconciliationRow[];
  /** Flex closed it; our evening-first status does not say closed. */
  closedInFlexNotHere: ReconciliationRow[];
  counts: {
    matched: number;
    closedHereNotInFlex: number;
    closedInFlexNotHere: number;
  };
}

function hoursSince(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.round(((nowMs - then) / 3_600_000) * 10) / 10);
}

/**
 * Pure bucketer — no database. `closedHere` is every row of the day (the closed-set
 * filter happens here so the caller cannot forget it); `flexClosures` is every stored
 * closure whose `closed_on` is that day.
 *
 * Matching is WO id first, then Case id — the same precedence, and the same
 * `normalizeKey`, that the report enricher uses, so a row can never match in one place
 * and miss in the other.
 */
export function bucketReconciliation(input: {
  date: string;
  closedHere: readonly ClosedHereRow[];
  flexClosures: readonly FlexClosureRow[];
  nowMs: number;
}): ClosureReconciliation {
  const flexByWo = new Map<string, FlexClosureRow>();
  const flexByCase = new Map<string, FlexClosureRow>();
  for (const closure of input.flexClosures) {
    const wo = normalizeKey(closure.woId);
    const caseKey = normalizeKey(closure.caseId);
    if (wo) flexByWo.set(wo, closure);
    if (caseKey) flexByCase.set(caseKey, closure);
  }

  const matched: ReconciliationRow[] = [];
  const closedHereNotInFlex: ReconciliationRow[] = [];
  const consumed = new Set<FlexClosureRow>();

  for (const row of input.closedHere) {
    const status = eveningFirstStatus(row);
    if (!isClosedHereStatus(status)) continue;

    const wo = normalizeKey(row.ticketId);
    const caseKey = normalizeKey(row.caseId);
    const closure =
      (wo && flexByWo.get(wo)) || (caseKey && flexByCase.get(caseKey)) || null;

    const entry: ReconciliationRow = {
      ticketId: row.ticketId,
      caseId: row.caseId,
      aspCode: row.aspCode || closure?.aspCode || "",
      rtplStatus: status,
      closureStatus: closure?.status ?? "",
      closureDate: closure?.closureDate ?? "",
      hoursSinceClosedHere: hoursSince(row.closedAt, input.nowMs),
    };

    if (closure) {
      consumed.add(closure);
      matched.push(entry);
    } else {
      closedHereNotInFlex.push(entry);
    }
  }

  // Whatever Flex closed today that no closed-here row claimed. The closure status rides
  // along so a "Closed - Canceled" is visibly different from a genuine "WO Closed".
  const closedInFlexNotHere: ReconciliationRow[] = input.flexClosures
    .filter((closure) => !consumed.has(closure))
    .map((closure) => ({
      ticketId: closure.woId,
      caseId: closure.caseId,
      aspCode: closure.aspCode,
      rtplStatus: "",
      closureStatus: closure.status,
      closureDate: closure.closureDate,
      hoursSinceClosedHere: null,
    }));

  return {
    date: input.date,
    matched,
    closedHereNotInFlex,
    closedInFlexNotHere,
    counts: {
      matched: matched.length,
      closedHereNotInFlex: closedHereNotInFlex.length,
      closedInFlexNotHere: closedInFlexNotHere.length,
    },
  };
}

// ----------------------------------------------------------------------- loading

/**
 * Every distinct work order in the day's report(s). A day can hold several reports (a
 * re-upload generates another one), so rows are collapsed per work order keeping the most
 * recently touched — the same "latest wins" rule the Evening-status authority uses.
 */
async function loadDayRows(
  reportDate: string,
  allowedAspCodes: string[] | null,
): Promise<ClosedHereRow[]> {
  const result = await query<{
    ticket_id: string | null;
    case_id: string | null;
    asp_code: string;
    rtpl_status: string | null;
    previous_rtpl_status: string | null;
    evening_rtpl_status: string | null;
    closed_at: string | null;
  }>(
    `WITH day_rows AS (
       SELECT rows.ticket_id,
              rows.case_id,
              UPPER(TRIM(COALESCE(rows.work_location, '')))       AS asp_code,
              rows.rtpl_status,
              rows.previous_rtpl_status,
              rows.evening_rtpl_status,
              COALESCE(rows.evening_rtpl_status_updated_at,
                       rows.updated_at,
                       reports.created_at)                        AS closed_at,
              ROW_NUMBER() OVER (
                PARTITION BY COALESCE(
                  NULLIF(UPPER(TRIM(COALESCE(rows.ticket_id, ''))), ''),
                  UPPER(TRIM(COALESCE(rows.case_id, '')))
                )
                ORDER BY COALESCE(rows.evening_rtpl_status_updated_at,
                                  rows.updated_at,
                                  reports.created_at) DESC,
                         rows.id DESC
              ) AS rn
         FROM daily_call_plan_report_rows rows
         JOIN daily_call_plan_reports reports ON reports.id = rows.report_id
        WHERE reports.report_date = $1::date
          AND NOT rows.is_excluded
     )
     SELECT ticket_id,
            case_id,
            asp_code,
            rtpl_status,
            previous_rtpl_status,
            evening_rtpl_status,
            to_char(closed_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS closed_at
       FROM day_rows
      WHERE rn = 1
        AND ($2::text[] IS NULL OR asp_code = ANY($2::text[]))`,
    [reportDate, allowedAspCodes],
  );

  return result.rows.map((row) => ({
    ticketId: row.ticket_id ?? "",
    caseId: row.case_id ?? "",
    aspCode: row.asp_code,
    rtplStatus: row.rtpl_status,
    previousRtplStatus: row.previous_rtpl_status,
    eveningRtplStatus: row.evening_rtpl_status,
    closedAt: row.closed_at,
  }));
}

/**
 * Flex's closures for the day. Region comes from the file's own Work Location (041); the
 * fallback to '' means a pre-041 row simply carries no region rather than being dropped —
 * but an ASP-scoped principal must never see one, so the scope filter excludes blanks.
 */
async function loadFlexClosures(
  closedOn: string,
  allowedAspCodes: string[] | null,
): Promise<FlexClosureRow[]> {
  const result = await query<{
    wo_id: string;
    case_id: string;
    asp_code: string;
    closure_status: string | null;
    closure_date: string | null;
  }>(
    `SELECT wo_id,
            case_id,
            UPPER(TRIM(COALESCE(work_location, '')))     AS asp_code,
            closure_status,
            to_char(closure_date, 'DD-MM-YYYY')          AS closure_date
       FROM case_closure_dates
      WHERE closed_on = $1::date
        AND ($2::text[] IS NULL
             OR UPPER(TRIM(COALESCE(work_location, ''))) = ANY($2::text[]))`,
    [closedOn, allowedAspCodes],
  );

  return result.rows.map((row) => ({
    woId: row.wo_id,
    caseId: row.case_id,
    aspCode: row.asp_code,
    status: row.closure_status ?? "",
    closureDate: row.closure_date ?? "",
  }));
}

export async function reconcileClosuresForDate(input: {
  date: string;
  /** ASP codes the caller may read, or null for unrestricted. */
  allowedAspCodes: string[] | null;
  /** Narrow to one ASP; '' = every ASP the caller may read. */
  aspCode?: string;
}): Promise<ClosureReconciliation> {
  const asp = (input.aspCode ?? "").trim().toUpperCase();
  // A single-ASP request intersects with the caller's scope; the controller has already
  // rejected an ASP outside it, so this is just the narrowing.
  const scope = asp ? [asp] : input.allowedAspCodes;

  const [closedHere, flexClosures] = await Promise.all([
    loadDayRows(input.date, scope),
    loadFlexClosures(input.date, scope),
  ]);

  return bucketReconciliation({
    date: input.date,
    closedHere,
    flexClosures,
    nowMs: Date.now(),
  });
}
