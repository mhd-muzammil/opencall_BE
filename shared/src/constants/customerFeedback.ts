/**
 * Fixed dropdown options for closed-call customer feedback. Kept uniform (a small closed
 * set) so the resulting Customer Status can be charted / aggregated cleanly. Both the
 * backend (validation) and the frontend (dropdowns) read these, so the two never drift.
 */

export const CALL_STATUS_OPTIONS: readonly string[] = [
  "Called",
  "Not Reachable",
  "Callback Requested",
  "Wrong Number",
  "Other",
];

export const CUSTOMER_FEEDBACK_OPTIONS: readonly string[] = [
  "Satisfied",
  "Not Satisfied",
  "Issue Pending",
  "No Response",
  "Other",
];

export function isCallStatus(value: string): boolean {
  return CALL_STATUS_OPTIONS.includes(value);
}

export function isCustomerFeedbackOption(value: string): boolean {
  return CUSTOMER_FEEDBACK_OPTIONS.includes(value);
}
