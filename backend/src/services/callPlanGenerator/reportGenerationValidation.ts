import type { UploadSourceType } from "@opencall/shared";
import type { PoolClient } from "pg";
import { findUploadBatchesForValidation } from "../../repositories/uploadBatchRepository.js";
import type { GenerateDailyCallPlanInput } from "../../types/reportGeneration.js";
import {
  badRequest,
  conflict,
  unprocessableEntity,
} from "../../utils/httpError.js";

interface ExpectedBatch {
  id: string;
  sourceType: UploadSourceType;
  label: string;
}

interface ExistingReportRow {
  id: string;
}

function assertDistinctBatchIds(input: GenerateDailyCallPlanInput): void {
  const ids = [
    input.flexUploadBatchId,
    input.renderwaysUploadBatchId,
    input.callPlanUploadBatchId,
  ].filter((id): id is string => Boolean(id));

  if (new Set(ids).size !== ids.length) {
    throw badRequest("Upload batch IDs must be distinct", {
      flexUploadBatchId: input.flexUploadBatchId,
      renderwaysUploadBatchId: input.renderwaysUploadBatchId,
      callPlanUploadBatchId: input.callPlanUploadBatchId,
    });
  }
}

function assertValidReportDate(reportDate: string): void {
  const parsed = new Date(`${reportDate}T00:00:00.000Z`);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== reportDate
  ) {
    throw badRequest("Invalid reportDate", { reportDate });
  }
}

export async function validateReportGenerationTransaction(
  client: PoolClient,
  input: GenerateDailyCallPlanInput,
): Promise<string | null> {
  assertDistinctBatchIds(input);
  assertValidReportDate(input.reportDate);

  const expectedBatches: ExpectedBatch[] = [
    {
      id: input.flexUploadBatchId,
      sourceType: "FLEX_WIP",
      label: "Flex WIP",
    },
  ];
  if (input.renderwaysUploadBatchId) {
    expectedBatches.push({
      id: input.renderwaysUploadBatchId,
      sourceType: "RENDERWAYS",
      label: "Renderways",
    });
  }
  if (input.callPlanUploadBatchId) {
    expectedBatches.push({
      id: input.callPlanUploadBatchId,
      sourceType: "CALL_PLAN",
      label: "Call Plan",
    });
  }
  const lockKey = [
    input.reportDate,
    input.flexUploadBatchId,
    input.renderwaysUploadBatchId ?? "NO_RENDERWAYS",
    input.callPlanUploadBatchId ?? "NO_CALL_PLAN",
  ].join(":");

  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);

  const existingReport = await client.query<ExistingReportRow>(
    `
      SELECT id
      FROM daily_call_plan_reports
      WHERE report_date = $1
        AND flex_upload_batch_id = $2
        AND renderways_upload_batch_id IS NOT DISTINCT FROM $3
        AND call_plan_upload_batch_id IS NOT DISTINCT FROM $4
      LIMIT 1
    `,
    [
      input.reportDate,
      input.flexUploadBatchId,
      input.renderwaysUploadBatchId,
      input.callPlanUploadBatchId,
    ],
  );

  if (existingReport.rows[0]) {
    return existingReport.rows[0].id;
  }

  const batchRecords = await findUploadBatchesForValidation(
    client,
    expectedBatches.map((batch) => batch.id),
  );
  const batchById = new Map(batchRecords.map((batch) => [batch.id, batch]));
  const validationErrors: unknown[] = [];

  for (const expectedBatch of expectedBatches) {
    const batch = batchById.get(expectedBatch.id);

    if (!batch) {
      validationErrors.push({
        source: expectedBatch.label,
        issue: "UPLOAD_BATCH_NOT_FOUND",
        uploadBatchId: expectedBatch.id,
      });
      continue;
    }

    if (batch.sourceType !== expectedBatch.sourceType) {
      validationErrors.push({
        source: expectedBatch.label,
        issue: "UPLOAD_BATCH_SOURCE_MISMATCH",
        expectedSourceType: expectedBatch.sourceType,
        actualSourceType: batch.sourceType,
      });
    }

    if (batch.status === "FAILED" || batch.errorCount > 0) {
      validationErrors.push({
        source: expectedBatch.label,
        issue: "UPLOAD_BATCH_HAS_VALIDATION_ERRORS",
        status: batch.status,
        errorCount: batch.errorCount,
      });
    }

    if (batch.rowCount <= 0) {
      validationErrors.push({
        source: expectedBatch.label,
        issue: "UPLOAD_BATCH_HAS_NO_ROWS",
        rowCount: batch.rowCount,
      });
    }

    if (
      input.regionId &&
      batch.regionId &&
      batch.regionId !== input.regionId &&
      batch.uploaderRole !== "SUPER_ADMIN"
    ) {
      validationErrors.push({
        source: expectedBatch.label,
        issue: "UPLOAD_BATCH_REGION_MISMATCH",
        expectedRegionId: input.regionId,
        actualRegionId: batch.regionId,
      });
    }
  }

  if (validationErrors.length > 0) {
    throw unprocessableEntity("Report generation validation failed", {
      validationErrors,
    });
  }

  return null;
}
