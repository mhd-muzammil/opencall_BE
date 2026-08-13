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
  findTicketDetailsByReportId,
  type TicketDetailRow,
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

  // The engineer-facing detail for each ticket, from the very row the call was
  // assigned on: customer, contact, product, and the postal address that tells
  // them where to actually go.
  let detailByTicket = new Map<string, TicketDetailRow>();
  const session = await findLatestCompletedSessionByReportDate(workingDate);
  if (session?.daily_call_plan_report_id) {
    detailByTicket = await findTicketDetailsByReportId(session.daily_call_plan_report_id);
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
      // A ticket with no row in the day's report is still pushed, so the count
      // keeps matching the Assigned column — it just carries no detail.
      const detail = detailByTicket.get(ticket);
      const input: PayrollBulkCaseInput = {
        external_ref: ticket,
        title: `Service call (${ticket})`.slice(0, 200),
        engineer_name: name,
        status: "assigned",
      };
      if (detail) {
        // The address the engineer travels to. Common Address is the more
        // complete of the two on most rows and is present where Customer
        // Address is blank, so it leads; the ASP work-location code is only a
        // last resort because it is not somewhere you can navigate to.
        const address = detail.commonAddress || detail.customerAddress || detail.workLocation;
        if (address) {
          input.address = detail.customerPincode
            ? `${address} - ${detail.customerPincode}`
            : address;
        }
        if (detail.customerName) {
          input.customer_name = detail.customerName;
        }
        if (detail.contact) {
          input.customer_phone = detail.contact;
        }
        // Only non-empty values, so the engineer's screen never shows a row
        // with a blank beside it.
        input.details = Object.fromEntries(
          Object.entries({
            ticket_id: detail.ticketId,
            case_id: detail.caseId,
            wip_aging: detail.wipAging,
            location: detail.location,
            engineer: detail.engineer,
            product_name: detail.productName,
            product_serial_no: detail.productSerialNo,
            product_line_name: detail.productLineName,
            work_location: detail.workLocation,
            account_name: detail.accountName,
            customer_name: detail.customerName,
            contact: detail.contact,
            customer_mail: detail.customerMail,
            common_address: detail.commonAddress,
            customer_address: detail.customerAddress,
            customer_pincode: detail.customerPincode,
          }).filter(([, value]) => value !== ""),
        );
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

  const payroll = await bulkDispatchCases(cases);
  return { configured: true, workingDate, rowsWithEngineer: cases.length, payroll };
}
