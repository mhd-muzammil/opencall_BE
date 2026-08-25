import type { EngineerProductivityResult } from "../analytics/engineerProductivity.js";

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
}
