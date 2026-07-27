import type { UploadSourceType } from "@opencall/shared";

export type UploadFieldName =
  | "flexWipReport"
  | "renderwaysReport"
  | "callPlan";

export interface UploadedSourceFile {
  sourceType: UploadSourceType;
  fieldName: UploadFieldName;
  file: Express.Multer.File;
}

export interface UploadColumnValidationResult {
  sourceType: UploadSourceType;
  originalFileName: string;
  rowNumber: number | null;
  isValid: boolean;
  detectedHeaders: string[];
  missingColumns: string[];
}

export interface CreateUploadBatchInput {
  sourceType: UploadSourceType;
  originalFileName: string;
  storedFilePath: string;
  uploadedBy: string;
  regionId: string | null;
  rowCount: number;
  errors: unknown[];
}

export interface UploadBatchRecord {
  id: string;
  sourceType: UploadSourceType;
  originalFileName: string;
  status: "UPLOADED" | "VALIDATED" | "FAILED" | "PROCESSED";
  rowCount: number;
  errorCount: number;
  createdAt: string;
}

export interface ParsedUploadSummary {
  sourceType: UploadSourceType;
  rowCount: number;
  issueCount: number;
  duplicateNormalizedTicketIds: string[];
  duplicateNormalizedCaseIds: string[];
  duplicateCount: number;
}

/**
 * Emitted when a region-scoped upload contains Flex rows outside that region's
 * ASP scope. Those rows are DISCARDED at generation (new out-of-scope cases
 * never enter any report), so the uploader must be told at upload time — a
 * full all-region file has to be uploaded unscoped instead.
 */
export interface UploadRegionScopeWarning {
  regionId: string;
  regionName: string;
  aspCodes: string[];
  /** Flex file rows whose Work Location is outside the region's ASP scope. */
  outOfScopeRowCount: number;
  /** Flex file rows with no Work Location at all — also dropped when scoped. */
  blankWorkLocationRowCount: number;
  sampleTicketIds: string[];
}
