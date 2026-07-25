import type { Request, RequestHandler } from "express";
import type { VendorAccessPrincipal } from "../types/auth.js";
import { loadAssignedReportForVendor } from "../services/vendorAccess/vendorReportService.js";
import { updateReportRowForVendor } from "../services/vendorAccess/vendorRowEditService.js";
import { listAssignmentsForVendor } from "../repositories/vendorCaseAssignmentRepository.js";
import { listEngineersForDropdown } from "../repositories/engineerRepository.js";
import type { ReportRowEditInput } from "../services/reportRows/reportRowEditService.js";
import { recordActivity } from "../services/audit/activityLogger.js";
import { reportRowEditRequestSchema } from "../validators/reportRowEditRequestValidator.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, forbidden } from "../utils/httpError.js";

/** Ensures the caller is a vendor-access principal (not a user / special-access). */
function requireVendor(request: Request): VendorAccessPrincipal {
  if (!request.vendorAccess) {
    throw forbidden("This endpoint is only for vendor logins");
  }
  return request.vendorAccess;
}

/** The vendor's own principal (granted views + permission level). */
export const getVendorMeController: RequestHandler = asyncHandler(
  async (request, response) => {
    response.json({ data: requireVendor(request) });
  },
);

/** The report filtered to ONLY this vendor's assigned cases. */
export const getVendorReportController: RequestHandler = asyncHandler(
  async (request, response) => {
    const principal = requireVendor(request);
    response.json({ data: await loadAssignedReportForVendor(principal) });
  },
);

/** The vendor's raw case-assignment list (ticket / case ids), for reference. */
export const getVendorAssignmentsController: RequestHandler = asyncHandler(
  async (request, response) => {
    const principal = requireVendor(request);
    response.json({ data: await listAssignmentsForVendor(principal.id) });
  },
);

/** Active engineers, for the vendor's case-edit engineer dropdown (all regions). */
export const getVendorEngineersController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireVendor(request);
    response.json({ data: await listEngineersForDropdown(null) });
  },
);

/** Update one of the vendor's OWN assigned cases (only when permission is 'update'). */
export const patchVendorReportRowController: RequestHandler = asyncHandler(
  async (request, response) => {
    const principal = requireVendor(request);
    const rowId = request.params.id?.trim();
    if (!rowId) {
      throw badRequest("Missing report row id");
    }

    const parsed = reportRowEditRequestSchema.parse(request.body);
    const values = Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value !== undefined),
    ) as ReportRowEditInput;

    const row = await updateReportRowForVendor({ rowId, principal, values });

    recordActivity({
      eventType: "REPORT_ROW_EDITED",
      actorEmailFallback: `vendor-access:${principal.username}`,
      regionId: row.regionId ?? null,
      targetType: "report_row",
      targetId: row.id,
      metadata: {
        vendorAccessId: principal.id,
        vendorAccessUsername: principal.username,
        reportId: row.reportId,
        serialNo: row.serialNo,
        ticketId: row.ticketId,
        caseId: row.caseId,
        workLocation: row.workLocation,
        changedFields: Object.keys(values),
      },
      request,
    });

    response.json({ data: row });
  },
);
