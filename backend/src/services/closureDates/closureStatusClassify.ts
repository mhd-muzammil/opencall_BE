/**
 * Classification of the Flex Closure ASP Report's `Status` column, in the style of
 * `flexRawData/flexRawClassify.ts`:
 *
 *   cancelled : status contains "CANCEL"
 *   closed    : status contains "CLOSE"   ("WO Closed", "Closed")
 *   other     : everything else (incl. blanks)
 *
 * ORDER MATTERS. The literal "Closed - Canceled" contains BOTH words; testing CLOSED
 * first would count it as a genuine completion. In the two real sample workbooks 9 of
 * 74 rows are exactly that, so getting this backwards inflates completions by ~12%.
 */
export type ClosureStatusGroup = "cancelled" | "closed" | "other";

export function classifyClosureStatus(status: unknown): ClosureStatusGroup {
  const s = String(status ?? "").toUpperCase();
  if (s.includes("CANCEL")) return "cancelled";
  if (s.includes("CLOSE")) return "closed";
  return "other";
}

/** Tally helper for import summaries and activity metadata. */
export interface ClosureStatusTally {
  closed: number;
  cancelled: number;
  other: number;
}

export function tallyClosureStatuses(
  statuses: readonly unknown[],
): ClosureStatusTally {
  const tally: ClosureStatusTally = { closed: 0, cancelled: 0, other: 0 };
  for (const status of statuses) {
    tally[classifyClosureStatus(status)] += 1;
  }
  return tally;
}
