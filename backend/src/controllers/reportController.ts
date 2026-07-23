import type { RequestHandler } from "express";
import { type Region } from "../repositories/regionRepository.js";
import { generateDailyCallPlanReport } from "../services/callPlanGenerator/dailyCallPlanGenerator.js";
import {
  findAllowedRegionsForUser,
  requireCurrentUser,
  resolveEffectiveRegionId,
} from "../services/rbac/regionAccessService.js";
import { aspCodesForRegion } from "../services/rbac/regionRowAccess.js";
import { syncPartsCallCountsFromReport } from "../services/partsCallCountSync.js";
import { enrichReportWithClosureDates } from "../services/closureDates/closureDateEnricher.js";
import { recordActivity } from "../services/audit/activityLogger.js";
import type { GeneratedDailyCallPlanReport } from "../types/reportGeneration.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { reportGenerationRequestSchema } from "../validators/reportGenerationRequestValidator.js";

function aspCodesForRegions(regions: readonly Region[]): Set<string> {
  const codes = new Set<string>();
  for (const region of regions) {
    for (const code of aspCodesForRegion(region)) {
      codes.add(code);
    }
  }
  return codes;
}

function filterReportForRegions(
  report: GeneratedDailyCallPlanReport,
  regions: readonly Region[],
): GeneratedDailyCallPlanReport {
  const wantedCodes = aspCodesForRegions(regions);
  const filteredRows = report.rows.filter((row) => {
    const aspCode = String(row.enriched.work_location ?? "")
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
    // Still validated for everyone: a REGION_ADMIN naming another region is
    // rejected here, exactly as before.
    const requestedRegionId = await resolveEffectiveRegionId(
      currentUser,
      body.regionId ?? null,
    );
    const isRegionAdmin = currentUser.role === "REGION_ADMIN";
    // null for SUPER_ADMIN (unrestricted); the managed-region list otherwise.
    const allowedRegions = await findAllowedRegionsForUser(currentUser);
    const report = await generateDailyCallPlanReport({
      ...body,
      generatedBy: currentUser.id,
      // A REGION_ADMIN generates into the shared all-region stream (regionId
      // null) so carry-forward chains stay unified across uploaders; what they
      // may AFFECT is bounded by allowedRegionAspCodes instead. A SUPER_ADMIN
      // keeps explicit region tagging as before.
      regionId: isRegionAdmin ? null : requestedRegionId,
      allowCreate: true,
      allowedRegionAspCodes: allowedRegions
        ? [...aspCodesForRegions(allowedRegions)]
        : null,
    });

    // Keep the inventory HP Stock "Active Part Cases" count in step with this report.
    // Fire-and-forget over the report we already have: it never re-generates, never
    // blocks the response, and a failure here cannot affect report generation.
    syncPartsCallCountsFromReport(report);

    // Region admins can create reports now, so their generations are audited too.
    recordActivity({
      eventType: "REPORT_GENERATED",
      actor: {
        id: currentUser.id,
        email: currentUser.email,
        role: currentUser.role,
      },
      regionId: requestedRegionId,
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

    if (isRegionAdmin && allowedRegions && allowedRegions.length > 0) {
      response.status(201).json({
        data: await enrichReportWithClosureDates(
          filterReportForRegions(report, allowedRegions),
        ),
      });
      return;
    }

    response.status(201).json({
      data: await enrichReportWithClosureDates(report),
    });
  });
