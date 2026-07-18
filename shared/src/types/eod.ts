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
