import type { GeoPoint } from "../utils/geo.js";
import type {
  CallPlanParsedRecord,
  FlexWipParsedRecord,
  RenderwaysParsedRecord,
} from "./sourceRecords.js";

export type MatchConfidence = "TICKET_ID" | "CASE_ID" | "UNMATCHED";
export type MatchStatus =
  | "MATCHED"
  | "RENDERWAYS_MISSING"
  | "FLEX_MISSING"
  | "CALLPLAN_MISSING"
  | "BOTH_MISSING";

export interface SourceDuplicateSummary {
  duplicateNormalizedTicketIds: string[];
  duplicateNormalizedCaseIds: string[];
}

export interface DuplicateTrackingSummary {
  flexWip: number;
  renderways: number;
  callPlan: number;
  total: number;
}

export interface MatchedCallPlanInput {
  renderways: readonly RenderwaysParsedRecord[];
  flexWip: readonly FlexWipParsedRecord[];
  callPlan: readonly CallPlanParsedRecord[];
  slaHoursByWipAgingCategory?: ReadonlyMap<string, number> | Record<string, number>;
  areaNameByPincode?: ReadonlyMap<string, string> | Record<string, string>;
  /**
   * Branch office coordinates keyed by ASP work-location code, and pincode
   * centroids keyed by pincode. Together they give each row its distance and
   * direction from the office that owns it. Both optional: without them the
   * Distance column is blank, which is how every existing caller behaves.
   */
  officeByAspCode?: ReadonlyMap<string, GeoPoint>;
  coordinatesByPincode?: ReadonlyMap<string, GeoPoint>;
  /** Routed road distances keyed by roadDistanceKey(aspCode, pincode). */
  roadDistanceByOfficePincode?: ReadonlyMap<string, number>;
  /**
   * Provider-geocoded coordinates keyed by NORMALIZED ticket id — the
   * exact-address tier. Optional like the maps above; a ticket without an
   * entry (or one whose coordinate fails the pincode sanity gate) stays on
   * the pincode tier.
   */
  preciseCoordByTicketId?: ReadonlyMap<string, PreciseWorkOrderCoordinate>;
  /** Routed road distances keyed by addressRoadDistanceKey(aspCode, addressKey). */
  roadDistanceByOfficeAddress?: ReadonlyMap<string, number>;
}

/** A work order's provider-geocoded coordinate (the exact-address tier). */
export interface PreciseWorkOrderCoordinate extends GeoPoint {
  /** geocode_cache key its address resolved under — routes are stored per address. */
  addressKey: string;
}

export interface EnrichedCallPlanRow {
  ticket_id: string;
  case_id: string;
  case_created_time: string | null;
  wip_aging: string | null;
  /** Morning (BOD) RTPL status — the read-only start-of-day baseline. */
  rtpl_status: string;
  /**
   * Evening (EOD) RTPL status — editable, blank until worked and blank at the
   * start of each new day. On the next day's upload it is promoted to Morning.
   */
  evening_rtpl_status?: string | null;
  segment: string;
  engineer: string | null;
  product: string | null;
  product_line_name: string | null;
  work_location: string | null;
  flex_status: string | null;
  status_aging: string | null;
  /** Renderways "current status aging" in days (numeric). */
  current_status_aging: number | null;
  hp_owner_status: string | null;
  wo_otc_code: string | null;
  account_name: string | null;
  customer_name: string | null;
  customer_type: string | null;
  location: string | null;
  /**
   * Road-distance ESTIMATE in km from the branch office that owns this call, and
   * the 16-point compass direction to it. Null when the branch has no surveyed
   * coordinate or the customer pincode does not resolve — a blank cell, never a
   * guess, because a wrong distance silently mis-ranks a dispatcher's morning.
   */
  distance_km: number | null;
  distance_bearing: string | null;
  /**
   * True when distance_km came from real routing; false when it is the
   * straight-line estimate, which the report renders with a leading tilde.
   */
  distance_is_routed: boolean;
  contact: string | null;
  part: string | null;
  /**
   * WO-level part-shipment status (most-blocking of the part lines) resolved at
   * generation from flexWip.parts. TRANSIENT — used only to derive the auto-RCA
   * ETA during generation; not mapped to an output column and not persisted.
   */
  part_shipment_status?: string | null;
  product_serial_no: string | null;
  wip_aging_category: string | null;
  tat: string | null;
  customer_mail: string | null;
  rca: string | null;
  remarks: string | null;
  manual_notes: string | null;
  match_status: MatchStatus;
}

export interface MatchedCallPlanRecord {
  renderways: RenderwaysParsedRecord | null;
  flexWip: FlexWipParsedRecord | null;
  callPlan: CallPlanParsedRecord | null;
  flexMatchConfidence: MatchConfidence;
  callPlanMatchConfidence: Exclude<MatchConfidence, "CASE_ID">;
  matchStatus: MatchStatus;
  enrichedRow: EnrichedCallPlanRow;
  notes: string[];
}
