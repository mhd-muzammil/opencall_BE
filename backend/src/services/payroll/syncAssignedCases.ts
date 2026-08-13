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
import { HttpError } from "../../utils/httpError.js";
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

/**
 * @param options.mirror Whether this push is authoritative for the CURRENT plan.
 *   Payroll mirrors an authoritative push by cancelling every synced case absent
 *   from it. True is right for the scheduled sync of today; a sync of some other
 *   date speaks only for that date, so it must pass false or it retracts the
 *   live cases engineers are working right now.
 */
export async function syncAssignedCasesForDate(
  workingDate: string,
  options: { mirror?: boolean } = {},
): Promise<PayrollSyncResult> {
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
  } catch (error) {
    // Only a rejected DATE is a benign "nothing to sync". A DB/connection fault
    // must NOT be reported as "no report for this date" — that reads as normal
    // and hides a real outage behind a reassuring message.
    if (error instanceof HttpError) {
      return {
        configured: true,
        workingDate,
        rowsWithEngineer: 0,
        message: `Cannot read the productivity view for ${workingDate}: ${error.message}`,
      };
    }
    throw error;
  }

  // Each engineer's Assigned tickets, merged across regions by name — the same
  // aggregation the productivity table does.
  const assignedByEngineer = new Map<string, Set<string>>();
  // Tickets the day's plan records as CLOSED. Assigned is the whole plan, and
  // engineerProductivity pushes every bucket into assignedTickets — closed ones
  // included — so without this set a call the engineer already finished keeps
  // being pushed as "assigned" and sits on their Payroll list looking like
  // outstanding work.
  const closedTickets = new Set<string>();
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
      for (const ticket of engineer.closedTickets ?? []) {
        const trimmed = ticket.trim();
        if (trimmed) {
          closedTickets.add(trimmed);
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
        // Tell Payroll the truth about the call instead of always saying
        // "assigned": a ticket the plan already records as closed must land as
        // completed, or the engineer keeps seeing finished work on their list.
        // Payroll treats a terminal status as authoritative over the field
        // status, so this also settles a case the engineer never closed there.
        status: closedTickets.has(ticket) ? "completed" : "assigned",
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
    // Say what WAS seen. "No assigned tickets" on a day the dashboard clearly
    // shows assignments means the sync and the view disagree about the date or
    // the region set, and the counts below are what tells them apart.
    return {
      configured: true,
      workingDate,
      rowsWithEngineer: 0,
      message:
        `No assigned tickets for this working date ` +
        `(regions=${productivity.regions.length}, engineers=${assignedByEngineer.size}).`,
    };
  }

  // Omit the flag entirely when the caller did not choose, so Payroll's default
  // stands (exactOptionalPropertyTypes forbids passing an explicit undefined).
  const payroll = await bulkDispatchCases(
    cases,
    options.mirror === undefined ? {} : { mirror: options.mirror },
  );
  return { configured: true, workingDate, rowsWithEngineer: cases.length, payroll };
}
