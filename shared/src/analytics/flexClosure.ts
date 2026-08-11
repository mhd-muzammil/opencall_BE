// The vendor's verdict on a work order it has closed, and the single test that
// separates a completed job from an abandoned one.
//
// This lives in shared because both sides must give the same answer. The
// dashboards and the Closed Calls tile ask it directly, and the
// engineer-productivity calculation — which the backend Final-EOD freeze runs
// too — filters on it. It previously existed ONLY in the frontend's
// reportUtils, which is exactly why productivity kept scoring a cancelled call
// as a completed close while every other surface excluded it.

/** The vendor's verdict on a work order it has closed. */
export type FlexClosureOutcome = "closed" | "cancelled" | "other";

function normalizeStatusText(status: unknown): string {
  return String(status ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Classifies the Flex Closure ASP Report's own status. Only "WO Closed" is a
 * completed job — the one that gets paid for; "Closed - Canceled" is an
 * abandoned call and must never be counted with it.
 *
 * ORDER MATTERS: the literal "Closed - Canceled" contains BOTH words, so CANCEL
 * is tested first. Mirrors the backend's `classifyClosureStatus`
 * (services/closureDates/closureStatusClassify.ts) — the two must agree.
 */
export function classifyFlexClosureOutcome(status: unknown): FlexClosureOutcome {
  const s = String(status ?? "").toUpperCase();
  if (s.includes("CANCEL")) return "cancelled";
  if (s.includes("CLOSE")) return "closed";
  return "other";
}

/**
 * True when the serve-time closure overlay rewrote this row's Flex Status, i.e.
 * Flex has actually told us how the call ended. The overlay parks the vendor's
 * WIP value in "Flex Status (WIP)" whenever it fires, so the key's PRESENCE is
 * the marker — its value may legitimately be the empty string.
 *
 * Without it, "Flex Status" is just the WIP status and says nothing about the
 * outcome.
 */
export function hasFlexClosureOutcome(
  output: Record<string, unknown>,
): boolean {
  return "Flex Status (WIP)" in output;
}

/**
 * Whether a CLOSED row was a cancellation rather than a completed job — the test
 * behind "Closed Calls" vs "Closed cancelled" everywhere they are reported.
 *
 * Flex decides once it has reported the closure: only "WO Closed" is billable.
 * This used to test OUR OWN status column for the word "cancel", which misses
 * every call Flex cancelled while our column said something else — a row reading
 * Customer Pending in both Morning and Evening, with a Flex Status of
 * "Closed - Canceled", was counted as a completed closure.
 *
 * Until Flex reports, our column is the only signal there is, so the keyword
 * test stays as the fallback rather than being dropped.
 *
 * `ownStatus` is whichever column the caller reads — Morning for BOD, Evening
 * for EOD.
 */
export function isCancelledClosure(
  output: Record<string, unknown>,
  ownStatus: unknown,
): boolean {
  if (hasFlexClosureOutcome(output)) {
    return classifyFlexClosureOutcome(output["Flex Status"]) === "cancelled";
  }
  return normalizeStatusText(ownStatus).includes("cancel");
}
