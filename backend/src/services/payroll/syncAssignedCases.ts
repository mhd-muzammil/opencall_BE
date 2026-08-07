/**
 * "Sync assigned cases to Payroll".
 *
 * For a working date, reads the day's PERSISTED report rows and runs the SAME
 * `computeEngineerProductivity` the Engineer Productivity view uses, then pushes
 * each engineer's "Assigned" tickets to the Payroll app. Because it reuses the
 * exact productivity calculation (visible-row filter + ticket de-dup + plan
 * gate), the synced set is precisely each engineer's Assigned column — no more,
 * no fewer, and the same ticket IDs.
 *
 * Idempotent: external_ref = ticketId, so re-syncing updates the one case
 * instead of duplicating. Strictly READ-ONLY w.r.t. the OpenCall report. No-op
 * (never throws) when the Payroll integration isn't configured.
 */
import { computeEngineerProductivity, type ProductivityReportRow } from "@opencall/shared";
import {
  findProductivityRowsByReportId,
  type ProductivityPersistedRow,
} from "../../repositories/dailyCallPlanReportRepository.js";
import { findEngineerContactByName } from "../../repositories/engineerRepository.js";
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

/** Map a persisted row into the shape `computeEngineerProductivity` expects —
 * the SAME mapping the productivity/EOD service uses, so the numbers match. */
function toProductivityRow(row: ProductivityPersistedRow): ProductivityReportRow {
  return {
    serialNo: row.serialNo,
    output: {
      "Ticket ID": row.ticketId,
      Engineer: row.engineer,
      "RTPL status": row.rtplStatus,
      "Evening status": row.eveningRtplStatus,
      "Work Location": row.workLocation,
      "Flex Status": row.flexStatus,
    },
    carryForward: {
      closedSyntheticRow: row.closedSyntheticRow,
      sameDayClosedRow: row.sameDayClosedRow,
    },
    comparison: null,
  };
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

  const persisted = await findProductivityRowsByReportId(session.daily_call_plan_report_id);

  // EXACT same computation as the Engineer Productivity table — so the synced
  // set is precisely each engineer's Assigned tickets, with the same ticket IDs.
  const productivity = computeEngineerProductivity(persisted.map(toProductivityRow));

  // Ticket -> persisted row, for the work location (address) of each case.
  const rowByTicket = new Map<string, ProductivityPersistedRow>();
  for (const row of persisted) {
    const ticket = (row.ticketId ?? "").trim();
    if (ticket) {
      rowByTicket.set(ticket, row);
    }
  }

  // Resolve each engineer's email + phone once, so Payroll can match on those
  // reliable keys even when the name is spelled differently.
  const contactByName = new Map<string, { email: string | null; phone: string | null } | null>();
  for (const entry of productivity.list) {
    const name = entry.name.trim();
    if (name && !contactByName.has(name)) {
      contactByName.set(name, await findEngineerContactByName(name));
    }
  }

  const cases: PayrollBulkCaseInput[] = [];
  for (const entry of productivity.list) {
    const name = entry.name.trim();
    if (!name) {
      continue;
    }
    const contact = contactByName.get(name);
    for (const rawTicket of entry.assignedTickets) {
      const ticket = rawTicket.trim();
      // Skip the serial-number fallback the productivity calc uses for a blank
      // ticket — only real ticket IDs make a stable, idempotent external_ref.
      if (!ticket || !rowByTicket.has(ticket)) {
        continue;
      }
      const location = (rowByTicket.get(ticket)?.workLocation ?? "").trim();
      const input: PayrollBulkCaseInput = {
        external_ref: ticket,
        title: `Service call (${ticket})`.slice(0, 200),
        engineer_name: name,
        status: "assigned",
      };
      if (location) {
        input.address = location;
      }
      if (contact?.email) {
        input.engineer_email = contact.email;
      }
      if (contact?.phone) {
        input.engineer_phone = contact.phone;
      }
      cases.push(input);
    }
  }

  if (cases.length === 0) {
    return {
      configured: true,
      workingDate,
      rowsWithEngineer: 0,
      message: "No assigned tickets for this working date.",
    };
  }

  const payroll = await bulkDispatchCases(cases);
  return { configured: true, workingDate, rowsWithEngineer: cases.length, payroll };
}
