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
}

export interface EnrichedCallPlanRow {
  ticket_id: string;
  case_id: string;
  case_created_time: string | null;
  wip_aging: string | null;
  rtpl_status: string;
  segment: string;
  engineer: string | null;
  product: string | null;
  product_line_name: string | null;
  work_location: string | null;
  flex_status: string | null;
  status_aging: string | null;
  hp_owner_status: string | null;
  wo_otc_code: string | null;
  account_name: string | null;
  customer_name: string | null;
  customer_type: string | null;
  location: string | null;
  contact: string | null;
  part: string | null;
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
