import type {
  EngineerProductivityResult,
  ProductivityCallDay,
} from "../analytics/engineerProductivity.js";

export type RegionEodStatus = "OPEN" | "CLOSED";

/**
 * One region's day-boundary state for a working date, as served by
 * GET /reports/:date/eod-state. While CLOSED the frozen snapshot is included
 * so clients render the frozen numbers instead of a live compute.
 */
export interface RegionEodStateEntry {
  regionId: string;
  regionCode: string;
  regionName: string;
  workingDate: string;
  status: RegionEodStatus;
  closedAt: string | null;
  /** Display name (email/username) of who closed the day; null while OPEN. */
  closedBy: string | null;
  snapshot: EngineerProductivityResult | null;
}

export interface RegionEodStateResponse {
  workingDate: string;
  regions: RegionEodStateEntry[];
}

/**
 * Per-region productivity for a report date: the frozen snapshot when the
 * region's day is CLOSED, else a live compute. Served by
 * GET /reports/:date/productivity.
 */
export interface RegionProductivityEntry {
  regionId: string;
  regionCode: string;
  regionName: string;
  source: "FROZEN" | "LIVE";
  productivity: EngineerProductivityResult;
}

export interface ReportProductivityResponse {
  workingDate: string;
  regions: RegionProductivityEntry[];
}

/**
 * Per-region productivity summed over a RANGE of working dates, served by
 * GET /reports/productivity/range.
 *
 * Productivity is a day-scoped measure — a day's plan against that day's
 * outcomes — so a range is the days added together, not one report filtered by
 * some other date column. Each day contributes its frozen snapshot when the
 * region's day is CLOSED and a live compute otherwise, exactly as the
 * single-day endpoint does, so a range can never disagree with the days it is
 * made of.
 */
export interface RegionProductivityRangeEntry {
  regionId: string;
  regionCode: string;
  regionName: string;
  /** FROZEN when every counted day was frozen, LIVE when none was, else MIXED. */
  source: "FROZEN" | "LIVE" | "MIXED";
  productivity: EngineerProductivityResult;
  /**
   * Calls this region had in the period at all — every productivity-visible row
   * carrying one of its ASP codes, across the counted days.
   *
   * The denominator for "N booked of M calls". Productivity counts only calls
   * booked as Scheduled with an engineer, so a region that does not use that
   * flow reports near zero and looks identical to one that did no work. Without
   * this number that difference is invisible, and reading it off the database
   * is the only way to tell them apart.
   */
  callsInPeriod: number;
}

export interface ReportProductivityRangeResponse {
  /** Inclusive bounds actually applied (a reversed pair is swapped). */
  from: string;
  to: string;
  /** Dates in range that had a completed report and were counted. */
  days: string[];
  /**
   * Dates in range with no completed report. They contribute nothing rather
   * than failing the request — a range that spans a Sunday is still a range —
   * and are listed so the caller can say which days are not represented.
   */
  missingDays: string[];
  regions: RegionProductivityRangeEntry[];
  /**
   * One row per assigned call-day, present ONLY when the caller asked for
   * `detail=1`. Omitted by default: a bill cycle is ~2400 of these and the
   * table that renders every day needs none of them.
   */
  callDays?: ProductivityCallDayDetail[];
  /**
   * Distinct calls behind those call-days, across the whole range.
   *
   * The second half of "2441 day-bookings across 912 calls". Computed here so
   * the drill-down header and the Excel cover sheet cannot quote two different
   * figures for the same range. Distinct by ticket id across ALL engineers, so
   * a call reassigned mid-cycle counts once, not once per engineer.
   */
  uniqueCallCount?: number;
}

/**
 * One assigned call-day with the descriptive fields the summary cannot carry —
 * the row behind the number, served by GET /reports/productivity/range?detail=1.
 *
 * Feeds BOTH the Excel detail sheet and the on-screen drill-down, so clicking a
 * total and exporting it can never show different sets of rows. That divergence
 * is the bug this whole feature exists to close: the drill-down used to filter
 * the ONE report the browser holds, so a month's total opened onto today's
 * still-open calls and a 2441 landed on 30.
 */
export interface ProductivityCallDayDetail extends ProductivityCallDay {
  /**
   * The region that counted this call-day.
   *
   * Carried as the ID, not just the ASP code the calculation groups by, because
   * special access filters what it returns by granted region ID. Without it the
   * region filter can only be applied to the summary and every restricted login
   * would receive every region's rows in `callDays`.
   */
  regionId: string;
  woOtcCode: string;
  customerName: string;
  location: string;
  product: string;
  segment: string;
  /** ISO timestamp, or null when the report carried none. */
  caseCreatedTime: string | null;
  wipAging: string;
  /** ISO timestamp, or null. */
  tat: string | null;
  /** The three statuses AS AT this day — the range walks every day's rows. */
  flexStatus: string;
  rtplStatus: string;
  eveningStatus: string;
  /**
   * Which booking of this call this row is, and how many the range holds for
   * the same engineer: "1 of 3", "2 of 3".
   *
   * The whole reason a repeated WO is not a duplicate. A call booked on three
   * days IS three call-days, and without this the three rows are identical
   * except for a date nobody reads as significant. Counted per ENGINEER, because
   * a call reassigned mid-cycle is a fresh sequence for whoever picks it up —
   * their second booking is not "3 of 5" of somebody else's work.
   */
  bookingIndex: number;
  bookingCount: number;
}
