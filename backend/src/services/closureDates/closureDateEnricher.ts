import {
  loadClosureDateLookup,
  normalizeKey,
} from "../../repositories/caseClosureDateRepository.js";
import { loadCustomerFeedbackLookup } from "../../repositories/customerFeedbackRepository.js";

/**
 * Stamps each report row's outgoing `output` with values sourced from side tables keyed
 * by WO id (Ticket ID) first, then Case id:
 *   - `Case Closed Date`   from the imported closure table
 *   - `Flex Status`        overlaid with the vendor's own closure status, with the
 *                          original vendor value preserved in `Flex Status (WIP)`
 *   - `Status Remarks`     the closure's remarks
 *   - `Customer Status`    derived from captured customer feedback
 *   - `Customer Feedback`  the raw feedback (called flag + text), so the UI can prefill
 *
 * This is a shallow, in-place enrichment of the outgoing response only — it never
 * regenerates the report, never writes to daily_call_plan_report_rows, and leaves rows
 * without a match untouched. Any failure is swallowed and the report is returned as-is.
 *
 * Because the Flex Status overlay is display-only, `flex_status_unchanged_days`,
 * `previous_flex_status` and the day-over-day comparison keep computing off the STORED
 * vendor value. That is deliberate: a closure must not reset a stale-status streak.
 */
export async function enrichReportWithClosureDates<
  T extends {
    reportDate?: string;
    rows: Array<{ output: Record<string, unknown> }>;
  },
>(report: T): Promise<T> {
  try {
    // The day this report is FOR. The Flex Status overlay is scoped to it (see below);
    // an empty value disables the overlay rather than guessing.
    const reportDate = String(report.reportDate ?? "").slice(0, 10);
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

      const closure =
        (woId && byWoId.get(woId)) || (caseId && byCaseId.get(caseId)) || null;
      if (closure) {
        // Case Closed Date is historical fact and is stamped whenever we have one —
        // unchanged since it shipped, and it never misrepresents the current state.
        if (closure.closedOn) {
          output["Case Closed Date"] = closure.closedOn;
        }

        // The Flex Status overlay, however, is scoped to closures recorded FOR THIS
        // REPORT'S DAY.
        //
        // `case_closure_dates` is a running archive with no concept of a work order
        // being reopened: a WO closed in June stays in it forever. Overlaying on any
        // match therefore branded live calls — SSC Pending, Visit Estimate, Scheduled —
        // as "WO Closed" / "Closed - Canceled" purely because they had been closed at
        // some point in the past and later came back.
        //
        // Today's WIP file is the newer information: a work order present in it as an
        // active row is open in Flex right now, whatever an old closure record says. So
        // only a closure dated to this report's own day may rewrite the cell, which also
        // means reopening an older report still shows that day's closures.
        const closedOnThisReportDay =
          Boolean(reportDate) && closure.closedOnIso === reportDate;

        if (closure.status && closedOnThisReportDay) {
          // Keep the vendor's WIP-report value visible in its own column before
          // overwriting the cell the whole dashboard reads.
          output["Flex Status (WIP)"] = output["Flex Status"] ?? "";
          output["Flex Status"] = closure.status;

          if (closure.statusRemarks) {
            output["Status Remarks"] = closure.statusRemarks;
          }
        }
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
