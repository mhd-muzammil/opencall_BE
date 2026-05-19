import type {
  ParsedUploadSummary,
  UploadBatchRecord,
  UploadColumnValidationResult,
  UploadedSourceFile,
} from "../types/upload.js";
import { withTransaction } from "../config/database.js";
import { createUploadBatch } from "../repositories/uploadBatchRepository.js";
import {
  insertCallPlanRecords,
  insertFlexWipRecords,
  insertRenderwaysRecords,
} from "../repositories/sourceRecordRepository.js";
import { validateUploadedExcelHeaders } from "./excelParser/excelHeaderService.js";
import {
  parseSourceFile,
  type ParsedUploadBySource,
} from "./excelParser/sourceParserService.js";

export interface RegisterUploadsInput {
  uploadedBy: string;
  regionId: string | null;
  uploads: readonly UploadedSourceFile[];
}

export interface RegisterUploadsResult {
  batches: UploadBatchRecord[];
  validations: UploadColumnValidationResult[];
  parseSummaries: ParsedUploadSummary[];
}

type ParsedUpload =
  | {
      sourceType: "FLEX_WIP";
      originalFileName: string;
      parsed: ParsedUploadBySource["FLEX_WIP"];
    }
  | {
      sourceType: "RENDERWAYS";
      originalFileName: string;
      parsed: ParsedUploadBySource["RENDERWAYS"];
    }
  | {
      sourceType: "CALL_PLAN";
      originalFileName: string;
      parsed: ParsedUploadBySource["CALL_PLAN"];
    };

interface SourceUploadGroup {
  sourceType: ParsedUpload["sourceType"];
  uploads: UploadedSourceFile[];
  parsedUploads: ParsedUpload[];
}

const SOURCE_ORDER: ParsedUpload["sourceType"][] = [
  "FLEX_WIP",
  "RENDERWAYS",
  "CALL_PLAN",
];

function buildValidationErrors(
  validation: UploadColumnValidationResult | undefined,
): unknown[] {
  if (!validation || validation.isValid) {
    return [];
  }

  return [
    {
      type: "MISSING_COLUMNS",
      missingColumns: validation.missingColumns,
      detectedHeaders: validation.detectedHeaders,
    },
  ];
}

function buildParsedUpload(upload: UploadedSourceFile): ParsedUpload {
  switch (upload.sourceType) {
    case "FLEX_WIP":
      return {
        sourceType: "FLEX_WIP",
        originalFileName: upload.file.originalname,
        parsed: parseSourceFile("FLEX_WIP", upload.file.path),
      };
    case "RENDERWAYS":
      return {
        sourceType: "RENDERWAYS",
        originalFileName: upload.file.originalname,
        parsed: parseSourceFile("RENDERWAYS", upload.file.path),
      };
    case "CALL_PLAN":
      return {
        sourceType: "CALL_PLAN",
        originalFileName: upload.file.originalname,
        parsed: parseSourceFile("CALL_PLAN", upload.file.path),
      };
  }
}

function buildParseSummary(upload: ParsedUpload): ParsedUploadSummary {
  return {
    sourceType: upload.sourceType,
    rowCount: upload.parsed.records.length,
    issueCount: upload.parsed.issues.length,
    duplicateNormalizedTicketIds: upload.parsed.duplicateNormalizedTicketIds,
    duplicateNormalizedCaseIds: upload.parsed.duplicateNormalizedCaseIds,
    duplicateCount: upload.parsed.duplicateCount,
  };
}

function groupUploadsBySource(
  uploads: readonly UploadedSourceFile[],
  parsedUploads: readonly (ParsedUpload | null)[],
): SourceUploadGroup[] {
  return SOURCE_ORDER.flatMap((sourceType) => {
    const sourceUploads = uploads.filter((upload) => upload.sourceType === sourceType);

    if (sourceUploads.length === 0) {
      return [];
    }

    return [{
      sourceType,
      uploads: sourceUploads,
      parsedUploads: parsedUploads.filter(
        (upload): upload is ParsedUpload => upload?.sourceType === sourceType,
      ),
    }];
  });
}

function findValidationForUpload(
  validations: readonly UploadColumnValidationResult[],
  upload: UploadedSourceFile,
): UploadColumnValidationResult | undefined {
  return validations.find(
    (candidate) =>
      candidate.sourceType === upload.sourceType &&
      candidate.originalFileName === upload.file.originalname,
  );
}

function mergedOriginalFileName(uploads: readonly UploadedSourceFile[]): string {
  return uploads.map((upload) => upload.file.originalname).join(", ");
}

function mergedStoredFilePath(uploads: readonly UploadedSourceFile[]): string {
  return uploads.map((upload) => upload.file.path).join(";");
}

function sourceRowCount(group: SourceUploadGroup): number {
  return group.parsedUploads.reduce(
    (total, upload) => total + upload.parsed.records.length,
    0,
  );
}

function sourceErrors(
  group: SourceUploadGroup,
  validations: readonly UploadColumnValidationResult[],
): unknown[] {
  return group.uploads.flatMap((upload) => {
    const validation = findValidationForUpload(validations, upload);
    const parsedUpload = group.parsedUploads.find(
      (candidate) => candidate.originalFileName === upload.file.originalname,
    );

    return [
      ...buildValidationErrors(validation),
      ...(parsedUpload?.parsed.issues.map((issue) => ({
        type: "ROW_PARSE_ISSUE",
        originalFileName: upload.file.originalname,
        ...issue,
      })) ?? []),
    ];
  });
}

export async function registerUploadedReports(
  input: RegisterUploadsInput,
): Promise<RegisterUploadsResult> {
  const validations = validateUploadedExcelHeaders(input.uploads);
  const parsedUploads = input.uploads.map((upload) => {
    const validation = findValidationForUpload(validations, upload);

    return validation?.isValid ? buildParsedUpload(upload) : null;
  });
  const uploadGroups = groupUploadsBySource(input.uploads, parsedUploads);

  const batches = await withTransaction(async (client) => {
    const records: UploadBatchRecord[] = [];

    for (const group of uploadGroups) {
      const batch = await createUploadBatch(
        {
          sourceType: group.sourceType,
          originalFileName: mergedOriginalFileName(group.uploads),
          storedFilePath: mergedStoredFilePath(group.uploads),
          uploadedBy: input.uploadedBy,
          regionId: input.regionId,
          rowCount: sourceRowCount(group),
          errors: sourceErrors(group, validations),
        },
        client,
      );

      if (group.sourceType === "FLEX_WIP") {
        const recordsToInsert = group.parsedUploads.flatMap(
          (upload) => upload.sourceType === "FLEX_WIP" ? upload.parsed.records : [],
        );
        await insertFlexWipRecords(client, batch.id, recordsToInsert);
      }

      if (group.sourceType === "RENDERWAYS") {
        const recordsToInsert = group.parsedUploads.flatMap(
          (upload) => upload.sourceType === "RENDERWAYS" ? upload.parsed.records : [],
        );
        await insertRenderwaysRecords(
          client,
          batch.id,
          recordsToInsert,
        );
      }

      if (group.sourceType === "CALL_PLAN") {
        const recordsToInsert = group.parsedUploads.flatMap(
          (upload) => upload.sourceType === "CALL_PLAN" ? upload.parsed.records : [],
        );
        await insertCallPlanRecords(client, batch.id, recordsToInsert);
      }

      records.push(batch);
    }

    return records;
  });

  return {
    batches,
    validations,
    parseSummaries: parsedUploads
      .filter((upload): upload is ParsedUpload => upload !== null)
      .map(buildParseSummary),
  };
}
