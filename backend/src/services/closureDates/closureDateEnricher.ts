import {
  loadClosureDateLookup,
  normalizeKey,
} from "../../repositories/caseClosureDateRepository.js";
import { loadCustomerFeedbackLookup } from "../../repositories/customerFeedbackRepository.js";

/**
 * Stamps each report row's outgoing `output` with values sourced from side tables keyed
 * by WO id (Ticket ID) first, then Case id:
 *   - `Case Closed Date`   from the imported closure-date table
 *   - `Customer Status`    derived from captured customer feedback
 *   - `Customer Feedback`  the raw feedback (called flag + text), so the UI can prefill
 *
 * This is a shallow, in-place enrichment of the outgoing response only — it never
 * regenerates the report, never writes to daily_call_plan_report_rows, and leaves rows
 * without a match untouched. Any failure is swallowed and the report is returned as-is.
 */
export async function enrichReportWithClosureDates<
  T extends { rows: Array<{ output: Record<string, unknown> }> },
>(report: T): Promise<T> {
  try {
    const [{ byWoId, byCaseId }, feedback] = await Promise.all([
      loadClosureDateLookup(),
      loadCustomerFeedbackLookup(),
    ]);

    const nothingToDo =
      byWoId.size === 0 &&
      byCaseId.size === 0 &&
      feedback.byWoId.size === 0 &&
      feedback.byCaseId.size === 0;
    if (nothingToDo) {
      return report;
    }

    for (const row of report.rows) {
      const output = row.output;
      const woId = normalizeKey(
        String(output["Ticket ID"] ?? output["WO ID"] ?? ""),
      );
      const caseId = normalizeKey(String(output["Case ID"] ?? ""));

      const closureDate =
        (woId && byWoId.get(woId)) || (caseId && byCaseId.get(caseId)) || "";
      if (closureDate) {
        output["Case Closed Date"] = closureDate;
      }

      const fb =
        (woId && feedback.byWoId.get(woId)) ||
        (caseId && feedback.byCaseId.get(caseId)) ||
        null;
      if (fb) {
        // Customer Status is the human-readable summary shown in its own column, built
        // from the two uniform dropdown values (call status + feedback).
        const parts = [fb.callStatus, fb.feedback].filter((p) => p && p.trim());
        output["Customer Status"] = parts.join(" · ");
        // Raw feedback so the edit modal can prefill the existing dropdown values.
        output["Customer Feedback"] = {
          callStatus: fb.callStatus,
          feedback: fb.feedback,
          remarks: fb.remarks,
          updatedBy: fb.updatedBy,
          updatedAt: fb.updatedAt,
        };
      }
    }
  } catch (error) {
    console.error("[ClosureDates] enrichment failed (report served as-is):", error);
  }
  return report;
}
