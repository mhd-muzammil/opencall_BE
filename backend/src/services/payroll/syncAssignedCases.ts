/**
 * "Sync assigned cases to Payroll" backfill.
 *
 * For a working date, reads the day's PERSISTED report rows (the exact same
 * read-only source the Engineer Productivity view computes from), takes every
 * row that has an engineer assigned, and pushes them to the Payroll app as
 * cases so each engineer sees their full assigned list there — not only the one
 * ticket that happened to be freshly scheduled.
 *
 * Idempotent: external_ref = ticketId, so re-syncing the same day updates the
 * one case instead of duplicating. Strictly READ-ONLY w.r.t. the OpenCall
 * report — it only reads rows and calls Payroll. No-op (never throws) when the
 * Payroll integration isn't configured.
 */
import {
  findProductivityRowsByReportId,
  type ProductivityPersistedRow,
} from "../../repositories/dailyCallPlanReportRepository.js";
import { findLatestCompletedSessionByReportDate } from "../../repositories/historyRepository.js";
import {
  bulkDispatchCases,
  isPayrollConfigured,
  type PayrollBulkCaseInput,
  type PayrollBulkResult,
} from "./payrollClient.js";

export interface PayrollSyncResult {
  configured: boolean;
  workingDate: string;
  rowsWithEngineer: number;
  payroll?: PayrollBulkResult;
  message?: string;
}

/** A row already finished in OpenCall lands as "completed" in Payroll (so it
 * shows in history, not in the engineer's active queue); anything else as
 * "assigned". Tolerant string match — the status vocabulary is free-form. */
function externalStatusHint(row: ProductivityPersistedRow): string {
  const closed =
    row.closedSyntheticRow ||
    /clos/i.test(row.flexStatus ?? "") ||
    /clos|complete/i.test(row.eveningRtplStatus ?? "");
  return closed ? "completed" : "assigned";
}

export async function syncAssignedCasesForDate(workingDate: string): Promise<PayrollSyncResult> {
  if (!isPayrollConfigured()) {
    return {
      configured: false,
      workingDate,
      rowsWithEngineer: 0,
      message: "Payroll integration is not configured (set PAYROLL_API_URL/USER/PASSWORD).",
    };
  }

  const session = await findLatestCompletedSessionByReportDate(workingDate);
  if (!session?.daily_call_plan_report_id) {
    return {
      configured: true,
      workingDate,
      rowsWithEngineer: 0,
      message: "No completed report exists for this working date.",
    };
  }

  const rows = await findProductivityRowsByReportId(session.daily_call_plan_report_id);

  // Keep rows that actually name an engineer AND a ticket, de-duplicated by
  // ticket (a ticket is one case; last write wins).
  const byTicket = new Map<string, ProductivityPersistedRow>();
  for (const row of rows) {
    const ticket = (row.ticketId ?? "").trim();
    const engineer = (row.engineer ?? "").trim();
    if (ticket && engineer) {
      byTicket.set(ticket, row);
    }
  }

  if (byTicket.size === 0) {
    return {
      configured: true,
      workingDate,
      rowsWithEngineer: 0,
      message: "No engineer-assigned rows for this working date.",
    };
  }

  const cases: PayrollBulkCaseInput[] = [];
  for (const row of byTicket.values()) {
    const ticket = row.ticketId.trim();
    const location = (row.workLocation ?? "").trim();
    const input: PayrollBulkCaseInput = {
      external_ref: ticket,
      title: `Service call (${ticket})`.slice(0, 200),
      engineer_name: row.engineer.trim(),
      status: externalStatusHint(row),
    };
    if (location) {
      input.address = location;
    }
    cases.push(input);
  }

  const payroll = await bulkDispatchCases(cases);
  return { configured: true, workingDate, rowsWithEngineer: byTicket.size, payroll };
}
