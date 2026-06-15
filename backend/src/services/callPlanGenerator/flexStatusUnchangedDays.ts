/**
 * Pure helper for the per-ticket "Flex Status unchanged for X days" counter.
 *
 * The counter answers: how many *calendar days* has a ticket's Flex Status held
 * its current value? It is computed from the actual Flex Status history — the
 * Flex Status this ticket carried in each prior report (one report per calendar
 * day, ordered most-recent first) — together with each report's date.
 *
 * Why calendar days and not "number of reports": reports are not generated every
 * day (there can be multi-day gaps). We find the OLDEST consecutive prior report
 * whose Flex Status still matches today's value, then count the calendar days
 * from that report's date to today. Gaps between reports are bridged (we assume
 * the status held during a gap with no report).
 *
 * Semantics:
 * - No previous report at all (`hadPreviousReport === false`) => `null` (unknown).
 * - Status changed today, or the ticket is brand new (absent from the most recent
 *   prior report) => `0` (zero elapsed days at the current value).
 * - Otherwise => calendar days between today and the oldest consecutive prior
 *   report that still carried this value. The walk stops at the first prior
 *   report where the status differs or the ticket is absent (a gap).
 * - Blank Flex Status matches blank; blank-vs-value (either direction) is a
 *   change. Comparison ignores case and surrounding/collapsible whitespace.
 */

export interface FlexStatusHistoryPoint {
  /** The prior report's effective date, `YYYY-MM-DD`. */
  reportDate: string;
  /**
   * This ticket's Flex Status in that report. `undefined` means the ticket was
   * not present in that report (a gap that breaks the consecutive run); `null`
   * means it was present with a blank value.
   */
  flexStatus: string | null | undefined;
}

export interface ComputeFlexStatusUnchangedDaysFromHistoryInput {
  /** Today's Flex Status for the ticket (raw value, may be null/blank). */
  currentFlexStatus: string | null;
  /** Today's report date, `YYYY-MM-DD`. */
  reportDate: string;
  /** This ticket's history in each prior report, ordered most-recent first. */
  previousReports: ReadonlyArray<FlexStatusHistoryPoint>;
  /** Whether any previous report exists at all for this region/date window. */
  hadPreviousReport: boolean;
}

export function normalizeFlexStatus(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim().replace(/\s+/g, " ").toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/** Whole-day index for a `YYYY-MM-DD` date (UTC), or null if unparseable. */
function toEpochDay(dateStr: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr.trim());
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function computeFlexStatusUnchangedDaysFromHistory(
  input: ComputeFlexStatusUnchangedDaysFromHistoryInput,
): number | null {
  // No previous report exists at all: the value is unknown.
  if (!input.hadPreviousReport) {
    return null;
  }

  const current = normalizeFlexStatus(input.currentFlexStatus);

  // Walk back (most-recent first) through consecutive prior reports whose Flex
  // Status still matches today's, tracking the oldest such report's date.
  let oldestMatchingDate: string | null = null;
  for (const point of input.previousReports) {
    // Ticket absent in this prior report: the consecutive run is broken.
    if (point.flexStatus === undefined) {
      break;
    }
    // Flex Status differed on that day (blank-vs-value counts as a change).
    if (normalizeFlexStatus(point.flexStatus) !== current) {
      break;
    }
    oldestMatchingDate = point.reportDate;
  }

  // Status changed today (or brand-new ticket): zero elapsed days.
  if (oldestMatchingDate === null) {
    return 0;
  }

  const oldest = toEpochDay(oldestMatchingDate);
  const today = toEpochDay(input.reportDate);
  if (oldest === null || today === null) {
    return null;
  }

  const days = today - oldest;
  return days > 0 ? days : 0;
}
