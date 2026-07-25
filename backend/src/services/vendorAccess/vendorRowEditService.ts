import type { VendorAccessPrincipal } from "../../types/auth.js";
import {
  findDailyCallPlanReportRowForEdit,
  type EditedReportRow,
} from "../../repositories/dailyCallPlanReportRepository.js";
import {
  applyReportRowManualFieldEdit,
  type ReportRowEditInput,
} from "../reportRows/reportRowEditService.js";
import { isCaseAssignedToVendor } from "../../repositories/vendorCaseAssignmentRepository.js";
import { forbidden, unprocessableEntity } from "../../utils/httpError.js";

/**
 * Report-row editing for a VENDOR ACCESS credential.
 *
 * A vendor may only edit a case that is actually ASSIGNED to it — the same scope its
 * report is filtered by. On top of that it must hold the `update` permission level. All of
 * this is enforced here, server-side; the browser is never trusted. (Vendors are scoped by
 * assigned case, not by region/data-scope, so those checks do not apply.)
 */
export async function updateReportRowForVendor(input: {
  rowId: string;
  principal: VendorAccessPrincipal;
  values: ReportRowEditInput;
}): Promise<EditedReportRow> {
  const { rowId, principal, values } = input;

  if (principal.permissionLevel !== "update") {
    throw forbidden("This vendor login is view-only and cannot update cases");
  }

  const current = await findDailyCallPlanReportRowForEdit(rowId);
  if (!current) {
    throw unprocessableEntity("Report row does not exist", { rowId });
  }

  const assigned = await isCaseAssignedToVendor(
    principal.id,
    current.ticketId,
    current.caseId,
  );
  if (!assigned) {
    throw forbidden("This case is not assigned to you");
  }

  return applyReportRowManualFieldEdit({
    rowId,
    current,
    values,
    editor: { kind: "VENDOR_ACCESS", id: principal.id },
  });
}
