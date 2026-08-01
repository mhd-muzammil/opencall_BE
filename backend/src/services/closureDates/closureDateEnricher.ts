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
    rows: Array<{
      output: Record<string, unknown>;
      carryForward?: { closedSyntheticRow?: boolean } | undefined;
    }>;
  },
>(report: T): Promise<T> {
  try {
    // The day this report is FOR. Used by the overlay rule below; an empty value
    // means an open row is never overlaid rather than the date being guessed.
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

        // The Flex Status overlay turns on the ROW'S OWN STATE, not on the calendar.
        //
        //   closed row  -> overlay, whatever the closure's date. A call that has left
        //                  the WIP is closed, and the vendor status is the only thing
        //                  that says whether it was completed ("WO Closed") or
        //                  abandoned ("Closed - Canceled"). Yesterday's and last
        //                  month's closures show it too.
        //   open row    -> overlay ONLY for a closure dated to this report's day.
        //
        // The open-row restriction matters because `case_closure_dates` is a running
        // archive with no concept of a work order being REOPENED: a WO closed in June
        // stays in it forever. Overlaying every match branded live calls — SSC Pending,
        // Visit Estimate, Scheduled — as closed purely because they had once been
        // closed and later came back (16 such rows on 2026-08-01, against 3 real
        // closures). Today's WIP file is the newer truth about an active row.
        //
        // Keeping same-day closures on open rows is deliberate: when Flex closes a call
        // after the WIP file was pulled, that disagreement is exactly what the
        // reconciliation card reports as "Closed in Flex, not here".
        const isClosedRow = row.carryForward?.closedSyntheticRow === true;
        const closedOnThisReportDay =
          Boolean(reportDate) && closure.closedOnIso === reportDate;

        if (closure.status && (isClosedRow || closedOnThisReportDay)) {
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
