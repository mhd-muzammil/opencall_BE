/**
 * Shared types for the AMC / Warranty Renewal Pipeline.
 *
 * A "renewal lead" is DERIVED, not stored: it is an `hp_warranty_cache` row whose warranty
 * end date falls inside the requested window, joined at read time to the most recent report
 * row that carried the same serial (customer, contact, region, product). The only persisted
 * part is the human follow-up state — status / owner / remarks — in `renewal_leads`.
 *
 * Consumed by the Express API (`@opencall/api`) and the Next.js frontend so both agree on
 * the shape. Framework-free by design.
 */

/** Follow-up stage of a lead. A lead with no saved row is implicitly `New`. */
export type RenewalLeadStatus =
  | "New"
  | "Contacted"
  | "Quoted"
  | "Won"
  | "Lost"
  | "Not Interested";

export const RENEWAL_LEAD_STATUSES: readonly RenewalLeadStatus[] = [
  "New",
  "Contacted",
  "Quoted",
  "Won",
  "Lost",
  "Not Interested",
] as const;

export function isRenewalLeadStatus(value: string): value is RenewalLeadStatus {
  return (RENEWAL_LEAD_STATUSES as readonly string[]).includes(value);
}

/**
 * Which slice of the pipeline to show. `EXPIRING_30/60/90` are CUMULATIVE (60 includes 30)
 * so they read the way the UI chips are labelled — "expiring in the next 60 days".
 * `EXPIRED` is warranties that already lapsed, within the service's look-back.
 */
export type RenewalWindow =
  | "EXPIRING_30"
  | "EXPIRING_60"
  | "EXPIRING_90"
  | "EXPIRED"
  | "ALL";

export const RENEWAL_WINDOWS: readonly RenewalWindow[] = [
  "EXPIRING_30",
  "EXPIRING_60",
  "EXPIRING_90",
  "EXPIRED",
  "ALL",
] as const;

export function isRenewalWindow(value: string): value is RenewalWindow {
  return (RENEWAL_WINDOWS as readonly string[]).includes(value);
}

/** One renewal lead: derived warranty + customer facts, plus the saved follow-up state. */
export interface RenewalLeadRow {
  /** Normalised serial — the hp_warranty_cache key and the renewal_leads key. */
  serial: string;
  /** ISO `YYYY-MM-DD` warranty start date, or null when HP did not report one. */
  startDate: string | null;
  /** ISO `YYYY-MM-DD` warranty end date. Always present for a lead. */
  endDate: string;
  /**
   * Whole days from today (IST) until `endDate`. Negative = already expired,
   * 0 = expires today.
   */
  daysLeft: number;
  /** HP's product number for the serial, when known. */
  productNumber: string | null;

  /** Customer facts from the most recent report row carrying this serial (may be blank). */
  customerName: string;
  accountName: string;
  contact: string;
  customerMail: string;
  product: string;
  /** The ASP work-location code the call sat under (used for region scoping). */
  workLocation: string;
  /** Friendly region name resolved from `workLocation`, or "" when unmapped. */
  regionName: string;
  /** Most recent ticket seen for this serial, for traceability back to the call. */
  ticketId: string;
  /** ISO `YYYY-MM-DD` report date of that most recent row — "when we last saw them". */
  lastSeenDate: string | null;

  /** Saved follow-up state. `New` when nothing has been saved yet. */
  status: RenewalLeadStatus;
  owner: string;
  remarks: string;
  /** ISO timestamp of the last save, or null when never touched. */
  updatedAt: string | null;
}

/** Counts for the header chips. The expiring buckets are cumulative. */
export interface RenewalPipelineSummary {
  total: number;
  expiring30: number;
  expiring60: number;
  expiring90: number;
  expired: number;
  /** Lead count per follow-up status across the returned rows. */
  byStatus: Record<RenewalLeadStatus, number>;
}

export interface RenewalPipelineResponse {
  rows: RenewalLeadRow[];
  summary: RenewalPipelineSummary;
  /**
   * False when the warranty tables have not been migrated yet (the warranty subsystem is
   * applied by a script, not a numbered migration) — the UI then shows a setup hint
   * instead of an empty table.
   */
  available: boolean;
}

/** Payload for saving the follow-up state of one lead. */
export interface SaveRenewalLeadInput {
  serial: string;
  status: RenewalLeadStatus;
  owner: string;
  remarks: string;
}

export interface SaveRenewalLeadResponse {
  serial: string;
  status: RenewalLeadStatus;
  owner: string;
  remarks: string;
  updatedAt: string;
}
