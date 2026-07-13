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
  "status_aging",
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
  /**
   * A closed row that closed on a same-day re-upload, so it stays on the Records
   * page until the next day's first upload. Always false for rows closed by a
   * day's first upload — those leave the Records page immediately.
   */
  sameDayClosedRow: boolean;
  /**
   * An active row outside the uploader's region scope, reproduced verbatim from
   * the previous report because a region-scoped upload must not touch other
   * regions' calls. Transient (recomputed every generation, never persisted);
   * the row has no Flex match today, so unmatched/missing-RTPL counters skip it.
   */
  regionScopeRetainedRow: boolean;
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
  /**
   * Region scope (work-location ASP codes) this generation may affect; null or
   * undefined means unrestricted (SUPER_ADMIN). When set and a NEW report is being
   * created: file rows outside the scope are ignored (no new cases added), and the
   * previous report's out-of-scope rows are carried forward verbatim — an active
   * call in another region is never closed by this upload. Reopening an existing
   * report ignores the scope entirely.
   */
  allowedRegionAspCodes?: readonly string[] | null;
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
