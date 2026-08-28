import {
  loadClosureDateLookup,
  normalizeKey,
  type ClosureRecord,
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

    /**
     * ONE STORED CLOSURE MAY BE CLAIMED BY ONE ROW.
     *
     * A closure is a single work order's, but several rows can share a Case ID: a
     * revisit raised as "WO-035260625-1", or a repeat call that got a brand new WO
     * against the same case (WO-035252057 / WO-035340079 / WO-035372074 all carry case
     * 5162524657). Matching each row independently — WO id, else Case id — stamped that
     * one closure onto every one of them, so the Closed Calls count reported 2 or 3
     * completions for a job the vendor closed once. On 2026-08-28 that was 22 phantom
     * completions in a bill cycle, against a real total of 1,079 — and since we were
     * also missing 11 calls outright, the two errors nearly cancelled and the number
     * looked plausible.
     *
     * So the WO-id pass runs FIRST across every row and claims what it matches; the
     * Case-id fallback then only gets closures nobody claimed by WO. In every one of the
     * 21 duplicate groups seen in production the closure's own work order WAS among the
     * rows, so this hands each closure to the row that actually owns it and leaves the
     * revisit/repeat rows unstamped — which is the truth about them.
     *
     * The fallback itself stays: it is the only way a closure filed under a Case id we
     * never saw as a WO id reaches its row at all.
     */
    const rowKeys = report.rows.map((row) => ({
      row,
      woId: normalizeKey(
        String(row.output["Ticket ID"] ?? row.output["WO ID"] ?? ""),
      ),
      caseId: normalizeKey(String(row.output["Case ID"] ?? "")),
    }));

    const claimed = new Set<ClosureRecord>();
    const closureForRow = new Map<(typeof rowKeys)[number], ClosureRecord>();

    for (const entry of rowKeys) {
      const closure = entry.woId ? byWoId.get(entry.woId) : undefined;
      if (!closure) continue;
      closureForRow.set(entry, closure);
      claimed.add(closure);
    }
    for (const entry of rowKeys) {
      if (closureForRow.has(entry) || !entry.caseId) continue;
      const closure = byCaseId.get(entry.caseId);
      // Already stamped onto the row that owns it by WO id — taking it again here is
      // exactly the double count this pass exists to stop.
      if (!closure || claimed.has(closure)) continue;
      closureForRow.set(entry, closure);
      claimed.add(closure);
    }

    for (const entry of rowKeys) {
      const { row, woId, caseId } = entry;
      const output = row.output;

      const closure = closureForRow.get(entry) ?? null;
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
