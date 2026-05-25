import type { DailyCallPlanColumn } from "@opencall/shared";
import type {
  ReportChangeType,
  ReportComparisonSummary,
  ReportRowComparisonInsight,
} from "@opencall/shared";
import type {
  DuplicateTrackingSummary,
  EnrichedCallPlanRow,
  MatchedCallPlanRecord,
} from "./matching.js";

export type DailyCallPlanOutputRow = Record<DailyCallPlanColumn, string | number>;

export const MANUAL_CARRY_FORWARD_FIELDS = [
  "rtpl_status",
  "segment",
  "engineer",
  "location",
  "case_created_time",
  "hp_owner_status",
  "customer_mail",
  "rca",
] as const;

export const OPTIONAL_MANUAL_CARRY_FORWARD_FIELDS = [
  "remarks",
  "manual_notes",
] as const;

export type ManualCarryForwardField =
  | (typeof MANUAL_CARRY_FORWARD_FIELDS)[number]
  | (typeof OPTIONAL_MANUAL_CARRY_FORWARD_FIELDS)[number];

export interface ManualCarryForwardRowMetadata {
  carriedForwardFields: ManualCarryForwardField[];
  manualFieldsCompleted: boolean;
  manualFieldsMissing: ManualCarryForwardField[];
  changeType: ReportChangeType | "NEW_WORK_ORDER" | null;
  previousTicketMatched: boolean;
  closedSyntheticRow: boolean;
}

export interface ManualCarryForwardSummary {
  totalFieldsCarried: number;
  rowsAutoCompleted: number;
  rowsStillManual: number;
}

export interface GenerateDailyCallPlanInput {
  reportDate: string;
  generatedBy: string;
  regionId: string | null;
  flexUploadBatchId: string;
  renderwaysUploadBatchId?: string | null | undefined;
  callPlanUploadBatchId?: string | null | undefined;
  allowCreate?: boolean;
}

export interface GeneratedDailyCallPlanRow {
  id: string | null;
  serialNo: number;
  output: DailyCallPlanOutputRow;
  enriched: EnrichedCallPlanRow;
  match: MatchedCallPlanRecord;
  comparison: ReportRowComparisonInsight | null;
  carryForward: ManualCarryForwardRowMetadata;
  updatedAt: string | null;
  updatedBy: string | null;
  rowEditable: boolean;
  carryForwardSource: "PREVIOUS_FINAL_REPORT";
}

export interface GeneratedReportComparisonMetadata {
  skipped: boolean;
  reason: "NO_PREVIOUS_REPORT" | null;
  currentSessionId: string;
  previousSessionId: string | null;
  summary: ReportComparisonSummary | null;
  duplicateTicketIds: {
    current: string[];
    previous: string[];
  };
}

export interface RegionBreakdownEntry {
  aspCode: string;
  regionName: string;
  count: number;
  closedCount: number;
  woOtcCodeBreakdown: Array<{
    code: string;
    count: number;
  }>;
}

export interface GeneratedDailyCallPlanReport {
  reportId: string;
  sessionId: string;
  reportDate: string;
  columns: readonly DailyCallPlanColumn[];
  totalRows: number;
  duplicateTicketCount: number;
  unmatchedTicketCount: number;
  duplicateTracking: DuplicateTrackingSummary;
  carryForward: ManualCarryForwardSummary;
  comparison: GeneratedReportComparisonMetadata;
  regionBreakdown: RegionBreakdownEntry[];
  rows: GeneratedDailyCallPlanRow[];
}
