import type { RequestHandler } from "express";
import {
  requireCurrentUser,
} from "../services/rbac/regionAccessService.js";
import { updateReportRowManualFields, deleteReportRowService } from "../services/reportRows/reportRowEditService.js";
import { recordActivity } from "../services/audit/activityLogger.js";
import { updateReportRowManualFields } from "../services/reportRows/reportRowEditService.js";
import type { ReportRowEditInput } from "../services/reportRows/reportRowEditService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";
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
        changedFields: Object.keys(values),
      },
      request,
    });

    response.json({
      data: row,
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
