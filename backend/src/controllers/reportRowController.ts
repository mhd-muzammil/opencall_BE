import type { RequestHandler } from "express";
import {
  requireCurrentUser,
} from "../services/rbac/regionAccessService.js";
import { updateReportRowManualFields, deleteReportRowService } from "../services/reportRows/reportRowEditService.js";
import { recordActivity } from "../services/audit/activityLogger.js";
import type { ReportRowEditInput } from "../services/reportRows/reportRowEditService.js";
import { listRtplStatusChanges } from "../repositories/activityLogRepository.js";
import { findRegionById } from "../repositories/regionRepository.js";
import { aspCodesForRegion } from "../services/rbac/regionRowAccess.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, forbidden } from "../utils/httpError.js";
import { reportRowEditRequestSchema } from "../validators/reportRowEditRequestValidator.js";

export const updateReportRowController: RequestHandler = asyncHandler(
  async (request, response) => {
    const currentUser = requireCurrentUser(request.currentUser);
    const rowId = request.params.id?.trim();

    if (!rowId) {
      throw badRequest("Missing report row id");
    }

    const parsedValues = reportRowEditRequestSchema.parse(request.body);
    const values = Object.fromEntries(
      Object.entries(parsedValues).filter(([, value]) => value !== undefined),
    ) as ReportRowEditInput;
    const row = await updateReportRowManualFields({
      rowId,
      user: currentUser,
      values,
    });

    recordActivity({
      eventType: "REPORT_ROW_EDITED",
      actor: {
        id: currentUser.id,
        email: currentUser.email,
        role: currentUser.role,
      },
      regionId: row.regionId ?? currentUser.regionId ?? null,
      targetType: "report_row",
      targetId: row.id,
      metadata: {
        reportId: row.reportId,
        serialNo: row.serialNo,
        ticketId: row.ticketId,
        caseId: row.caseId,
        workLocation: row.workLocation,
        changedFields: Object.keys(values),
        ...(row.rtplStatusChange
          ? {
              rtplStatusChange: {
                fromStatus: row.rtplStatusChange.fromStatus,
                toStatus: row.rtplStatusChange.toStatus,
              },
            }
          : {}),
      },
      request,
    });

    response.json({
      data: row,
    });
  },
);

export const listRtplStatusChangesController: RequestHandler = asyncHandler(
  async (request, response) => {
    const currentUser = requireCurrentUser(request.currentUser);
    const reportId = String(request.query.reportId ?? "").trim();
    const parsedLimit = Number(request.query.limit ?? 50);

    if (!reportId) {
      throw badRequest("Missing report id");
    }

    let regionId: string | null | undefined;
    let workLocationCodes: string[] | undefined;

    if (currentUser.role === "REGION_ADMIN") {
      if (!currentUser.regionId) {
        throw forbidden("REGION_ADMIN user is not assigned to a region");
      }

      const region = await findRegionById(currentUser.regionId);
      if (!region) {
        throw forbidden("REGION_ADMIN user's region was not found", {
          userRegionId: currentUser.regionId,
        });
      }

      regionId = currentUser.regionId;
      workLocationCodes = Array.from(aspCodesForRegion(region));
    }

    const changes = await listRtplStatusChanges({
      reportId,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 50,
      ...(regionId ? { regionId } : {}),
      ...(workLocationCodes ? { workLocationCodes } : {}),
    });

    response.json({
      data: changes,
    });
  },
);

export const deleteReportRowController: RequestHandler = asyncHandler(
  async (request, response) => {
    const currentUser = requireCurrentUser(request.currentUser);
    const rowId = request.params.id?.trim();

    if (!rowId) {
      throw badRequest("Missing report row id");
    }

    await deleteReportRowService({
      rowId,
      user: currentUser,
    });

    response.json({
      success: true,
    });
  },
);
