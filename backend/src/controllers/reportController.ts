import type { RequestHandler } from "express";
import { findRegionById, type Region } from "../repositories/regionRepository.js";
import { generateDailyCallPlanReport } from "../services/callPlanGenerator/dailyCallPlanGenerator.js";
import {
  requireCurrentUser,
  resolveEffectiveRegionId,
} from "../services/rbac/regionAccessService.js";
import { aspCodesForRegion } from "../services/rbac/regionRowAccess.js";
import { recordActivity } from "../services/audit/activityLogger.js";
import type { GeneratedDailyCallPlanReport } from "../types/reportGeneration.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { reportGenerationRequestSchema } from "../validators/reportGenerationRequestValidator.js";

function filterReportForRegion(
  report: GeneratedDailyCallPlanReport,
  region: Region,
): GeneratedDailyCallPlanReport {
  const wantedCodes = aspCodesForRegion(region);
  const filteredRows = report.rows.filter((row) => {
    const aspCode = String(
      row.output["Work Location"] ?? row.enriched.work_location ?? "",
    )
      .trim()
      .toUpperCase();
    return wantedCodes.has(aspCode);
  });
  const filteredRegionBreakdown = report.regionBreakdown.filter((entry) =>
    wantedCodes.has(entry.aspCode.toUpperCase()),
  );
  return {
    ...report,
    rows: filteredRows,
    totalRows: filteredRows.length,
    regionBreakdown: filteredRegionBreakdown,
  };
}


export const generateDailyCallPlanReportController: RequestHandler =
  asyncHandler(async (request, response) => {
    const currentUser = requireCurrentUser(request.currentUser);
    const body = reportGenerationRequestSchema.parse({
      ...request.body,
      generatedBy: currentUser.id,
      regionId: request.header("x-region-id") ?? request.body.regionId ?? null,
    });
    const regionId = resolveEffectiveRegionId(
      currentUser,
      body.regionId ?? null,
    );
    const isRegionAdmin = currentUser.role === "REGION_ADMIN";
    const report = await generateDailyCallPlanReport({
      ...body,
      generatedBy: currentUser.id,
      regionId,
      allowCreate: !isRegionAdmin,
    });

    if (!isRegionAdmin) {
      recordActivity({
        eventType: "REPORT_GENERATED",
        actor: {
          id: currentUser.id,
          email: currentUser.email,
          role: currentUser.role,
        },
        regionId,
        targetType: "report",
        targetId: report.reportId,
        metadata: {
          reportDate: report.reportDate,
          totalRows: report.totalRows,
          duplicateTicketCount: report.duplicateTicketCount,
          unmatchedTicketCount: report.unmatchedTicketCount,
        },
        request,
      });
    }

    if (isRegionAdmin && currentUser.regionId) {
      const region = await findRegionById(currentUser.regionId);
      if (region) {
        response.status(201).json({
          data: filterReportForRegion(report, region),
        });
        return;
      }
    }

    response.status(201).json({
      data: report,
    });
  });
