/**
 * "Sync assigned cases to Payroll".
 *
 * Uses the SAME `getReportProductivity` the Engineer Productivity view is served
 * from — including the frozen Final-EOD snapshot for CLOSED regions — then
 * pushes each engineer's "Assigned" tickets to Payroll. Because it reuses the
 * exact view data (not a re-compute from raw rows), the synced set can NOT
 * diverge from what the productivity table shows: same engineers, same tickets.
 *
 * Idempotent: external_ref = ticketId. Strictly READ-ONLY w.r.t. OpenCall. No-op
 * (never throws) when the Payroll integration isn't configured.
 */
import {
  findProductivityRowsByReportId,
  type ProductivityPersistedRow,
} from "../../repositories/dailyCallPlanReportRepository.js";
import { findLatestCompletedSessionByReportDate } from "../../repositories/historyRepository.js";
import { findEngineerContactByName } from "../../repositories/engineerRepository.js";
import { getReportProductivity } from "../productivity/eodService.js";
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

export async function syncAssignedCasesForDate(workingDate: string): Promise<PayrollSyncResult> {
  if (!isPayrollConfigured()) {
    return {
      configured: false,
      workingDate,
      rowsWithEngineer: 0,
      message: "Payroll integration is not configured (set PAYROLL_API_URL/USER/PASSWORD).",
    };
  }

  // EXACTLY the data the Engineer Productivity view renders (frozen snapshot for
  // closed regions, live compute otherwise).
  let productivity;
  try {
    productivity = await getReportProductivity(workingDate);
  } catch {
    return {
      configured: true,
      workingDate,
      rowsWithEngineer: 0,
      message: "No completed report for this working date.",
    };
  }

  // Each engineer's Assigned tickets, merged across regions by name — the same
  // aggregation the productivity table does.
  const assignedByEngineer = new Map<string, Set<string>>();
  for (const region of productivity.regions) {
    for (const engineer of region.productivity.list) {
      const name = engineer.name.trim();
      if (!name) {
        continue;
      }
      let tickets = assignedByEngineer.get(name);
      if (!tickets) {
        tickets = new Set<string>();
        assignedByEngineer.set(name, tickets);
      }
      for (const ticket of engineer.assignedTickets) {
        const trimmed = ticket.trim();
        if (trimmed) {
          tickets.add(trimmed);
        }
      }
    }
  }

  // Best-effort Work Location per ticket, from the day's persisted rows.
  const rowByTicket = new Map<string, ProductivityPersistedRow>();
  const session = await findLatestCompletedSessionByReportDate(workingDate);
  if (session?.daily_call_plan_report_id) {
    const persisted = await findProductivityRowsByReportId(session.daily_call_plan_report_id);
    for (const row of persisted) {
      const ticket = (row.ticketId ?? "").trim();
      if (ticket) {
        rowByTicket.set(ticket, row);
      }
    }
  }

  // Resolve each engineer's email + phone once (reliable Payroll match keys).
  const contactByName = new Map<string, { email: string | null; phone: string | null } | null>();
  for (const name of assignedByEngineer.keys()) {
    contactByName.set(name, await findEngineerContactByName(name));
  }

  const cases: PayrollBulkCaseInput[] = [];
  for (const [name, tickets] of assignedByEngineer) {
    const contact = contactByName.get(name);
    for (const ticket of tickets) {
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
