import type { VendorAccessPrincipal } from "../../types/auth.js";
import type { GeneratedDailyCallPlanReport } from "../../types/reportGeneration.js";
import { generateDailyCallPlanReport } from "../callPlanGenerator/dailyCallPlanGenerator.js";
import { findLatestCompletedReportSession } from "../../repositories/historyRepository.js";
import { getNormalizedTicketKey } from "../normalization/dedupeRowsByTicket.js";
import { loadAssignedKeysForVendor } from "../../repositories/vendorCaseAssignmentRepository.js";

export interface VendorScopedReportResult {
  report: GeneratedDailyCallPlanReport | null;
  permissionLevel: VendorAccessPrincipal["permissionLevel"];
}

function normalizeCaseKey(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * Loads the globally-latest completed report and returns it filtered to ONLY the cases
 * assigned to this vendor (matched by normalized ticket id, then normalized case id).
 * Filtering is server-side, so a vendor can never receive an unassigned case. Returns
 * `report: null` when no report exists yet or the vendor has no assignments.
 */
export async function loadAssignedReportForVendor(
  principal: VendorAccessPrincipal,
): Promise<VendorScopedReportResult> {
  const base = { permissionLevel: principal.permissionLevel };

  const { ticketKeys, caseKeys } = await loadAssignedKeysForVendor(principal.id);
  const session = await findLatestCompletedReportSession();
  if (!session || !session.flex_upload_batch_id || ticketKeys.size + caseKeys.size === 0) {
    return { report: null, ...base };
  }

  const report = await generateDailyCallPlanReport({
    reportDate: session.report_date ?? "",
    generatedBy: session.user_id,
    regionId: null,
    flexUploadBatchId: session.flex_upload_batch_id,
    renderwaysUploadBatchId: session.renderways_upload_batch_id,
    callPlanUploadBatchId: session.call_plan_upload_batch_id,
    allowCreate: false,
  });

  const filteredRows = report.rows.filter((row) => {
    const output = row.output as unknown as Record<string, unknown>;
    const ticketKey = getNormalizedTicketKey(output["Ticket ID"]);
    if (ticketKey && ticketKeys.has(ticketKey)) return true;
    const caseKey = normalizeCaseKey(output["Case ID"]);
    if (caseKey && caseKeys.has(caseKey)) return true;
    return false;
  });

  const presentCodes = new Set(
    filteredRows.map((r) => String(r.enriched.work_location ?? "").trim().toUpperCase()),
  );

  return {
    report: {
      ...report,
      rows: filteredRows,
      totalRows: filteredRows.length,
      regionBreakdown: report.regionBreakdown.filter((entry) =>
        presentCodes.has(entry.aspCode.toUpperCase()),
      ),
    },
    ...base,
  };
}
