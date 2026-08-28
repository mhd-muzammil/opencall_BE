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

/**
 * The ordered rule itself, exported so the SQL form of this classification
 * (`caseClosureDateRepository`) can be BUILT from it rather than hand-copied. Two
 * hand-written copies of an order-sensitive rule is exactly how "Closed - Canceled"
 * ends up counted as a completion on one screen and not another.
 *
 * First match wins; anything unmatched is 'other'.
 */
export const CLOSURE_STATUS_MATCHERS: ReadonlyArray<{
  group: Exclude<ClosureStatusGroup, "other">;
  substring: string;
}> = [
  { group: "cancelled", substring: "CANCEL" },
  { group: "closed", substring: "CLOSE" },
];

export function classifyClosureStatus(status: unknown): ClosureStatusGroup {
  const s = String(status ?? "").toUpperCase();
  for (const matcher of CLOSURE_STATUS_MATCHERS) {
    if (s.includes(matcher.substring)) return matcher.group;
  }
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
