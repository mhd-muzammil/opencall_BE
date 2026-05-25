import type { RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { getUploadedSourceFiles } from "../validators/uploadFileValidator.js";
import { uploadRequestSchema } from "../validators/uploadRequestValidator.js";
import { registerUploadedReports } from "../services/uploadService.js";
import {
  requireCurrentUser,
  resolveEffectiveRegionId,
} from "../services/rbac/regionAccessService.js";
import { recordActivity } from "../services/audit/activityLogger.js";
import { createHistorySession } from "../repositories/historyRepository.js";

export const uploadReportsController: RequestHandler = asyncHandler(
  async (request, response) => {
    const currentUser = requireCurrentUser(request.currentUser);
    const metadata = uploadRequestSchema.parse({
      uploadedBy: currentUser.id,
      regionId: request.header("x-region-id") ?? request.body.regionId ?? null,
    });
    const regionId = resolveEffectiveRegionId(
      currentUser,
      metadata.regionId ?? null,
    );

    const uploads = getUploadedSourceFiles(request.files);
    const result = await registerUploadedReports({
      uploadedBy: currentUser.id,
      regionId,
      uploads,
    });
    const allSourcesValid = result.validations.every(
      (validation) => validation.isValid,
    );
    const allRowsParsed = result.parseSummaries.every(
      (summary) => summary.issueCount === 0,
    );

    const flexBatch = result.batches.find((b) => b.sourceType === "FLEX_WIP");
    if (flexBatch) {
      await createHistorySession(null, {
        userId: currentUser.id,
        title: `Report Session ${new Date().toLocaleDateString()}`,
        regionId,
        flexUploadBatchId: flexBatch.id,
        renderwaysUploadBatchId: result.batches.find((b) => b.sourceType === "RENDERWAYS")?.id ?? null,
        callPlanUploadBatchId: result.batches.find((b) => b.sourceType === "CALL_PLAN")?.id ?? null,
      }).catch(console.error); // Do not block upload if history session creation fails
    }

    for (const batch of result.batches) {
      const parseSummary = result.parseSummaries.find(
        (summary) => summary.sourceType === batch.sourceType,
      );
      recordActivity({
        eventType: "UPLOAD_CREATED",
        actor: {
          id: currentUser.id,
          email: currentUser.email,
          role: currentUser.role,
        },
        regionId,
        targetType: "upload_batch",
        targetId: batch.id,
        metadata: {
          sourceType: batch.sourceType,
          fileName: batch.originalFileName,
          rowCount: batch.rowCount,
          errorCount: batch.errorCount,
          status: batch.status,
          issueCount: parseSummary?.issueCount ?? 0,
        },
        status: batch.status === "FAILED" || batch.errorCount > 0 ? "FAILURE" : "SUCCESS",
        request,
      });
    }

    response.status(allSourcesValid && allRowsParsed ? 201 : 422).json({
      data: result,
    });
  },
);
