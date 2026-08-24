import {
  computeEngineerProductivity,
  type ProductivityReportRow,
} from "@opencall/shared";
import {
  findProductivityRowsByReportId,
  type ProductivityPersistedRow,
} from "../../repositories/dailyCallPlanReportRepository.js";
import {
  findClosedCallDetailsByReportId,
  type ClosedCallDetailRow,
} from "../../repositories/closedCallDetailRepository.js";
import { findReportDaysInRange } from "../../repositories/engineerTargetRepository.js";

/**
 * Closed Calls detail — the individual calls behind an Engineer Target close count,
 * each carrying its Segment, Product Name, Work Location and WO OTC CODE.
 *
 * The closed set is NOT recomputed here. Every day in the range is replayed through the
 * SAME `computeEngineerProductivity` the Engineer Target and Engineer Productivity views
 * use, and this service simply reads back that result's `closedTickets` and attaches the
 * descriptive columns. A call can therefore never appear in this list without having been
 * counted, or be counted without appearing here.
 *
 * Read-only, and entirely additive — no existing service, repository, route or
 * calculation is modified.
 */

/**
 * The shared-calc row shape from a persisted report row. Intentionally duplicated from
 * `engineerTargetService` rather than exporting that one — this feature must not edit an
 * existing file, and a six-field literal is cheaper to keep honest than a refactor.
 */
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

/** One closed call, as listed in the drill-down. */
export interface ClosedCallDetail extends ClosedCallDetailRow {
  /** The report date this call was closed on (YYYY-MM-DD). */
  date: string;
  /** ASP/region code the closing engineer worked under that day. */
  regionCode: string;
}

export interface ClosedCallDetailResponse {
  fromDate: string;
  toDate: string;
  /** Report days actually found in the range (a day with no report is simply absent). */
  reportDays: number;
  /** Always equals `calls.length`; sent so a caller can assert agreement cheaply. */
  totalClosed: number;
  calls: ClosedCallDetail[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(value: string, field: string): void {
  if (!ISO_DATE.test(value)) {
    throw new Error(`${field} must be a YYYY-MM-DD date`);
  }
}

/**
 * Every closed call in the range, with its descriptive columns.
 *
 * One pair of queries per report day — same shape and the same 62-day clamp as Engineer
 * Target, so a mistyped filter can never fan out unbounded.
 */
export async function getClosedCallDetails(input: {
  fromDate: string;
  toDate: string;
  /** null = unrestricted (SUPER_ADMIN); otherwise the caller's own ASP codes. */
  allowedAspCodes: Set<string> | null;
  /** Optional single-engineer filter, matched case-insensitively. */
  engineer?: string | null;
}): Promise<ClosedCallDetailResponse> {
  const { fromDate, toDate, allowedAspCodes } = input;
  assertIsoDate(fromDate, "fromDate");
  assertIsoDate(toDate, "toDate");

  const engineerFilter = (input.engineer ?? "").trim().toLowerCase();

  const days = await findReportDaysInRange(fromDate, toDate);
  const bounded = days.slice(0, 62).sort((a, b) => a.reportDate.localeCompare(b.reportDate));

  const calls: ClosedCallDetail[] = [];

  for (const day of bounded) {
    const persisted = await findProductivityRowsByReportId(day.reportId);
    const productivity = computeEngineerProductivity(persisted.map(toProductivityRow));

    // Which tickets closed on this day, and under whose name/region. Region scoping is
    // applied here — exactly as Engineer Target applies it — so a REGION_ADMIN can only
    // ever drill into calls their own count already included.
    const regionByTicket = new Map<string, string>();
    const ticketIds: string[] = [];
    for (const entry of productivity.list) {
      const regionCode = entry.regionCode ?? "";
      if (allowedAspCodes && !allowedAspCodes.has(regionCode.toUpperCase())) {
        continue;
      }
      if (engineerFilter && entry.name.trim().toLowerCase() !== engineerFilter) {
        continue;
      }
      for (const ticketId of entry.closedTickets) {
        regionByTicket.set(ticketId, regionCode);
        ticketIds.push(ticketId);
      }
    }

    if (ticketIds.length === 0) {
      continue;
    }

    const details = await findClosedCallDetailsByReportId(day.reportId, ticketIds);
    for (const detail of details) {
      calls.push({
        ...detail,
        date: day.reportDate,
        regionCode: regionByTicket.get(detail.ticketId) ?? "",
      });
    }
  }

  return {
    fromDate,
    toDate,
    reportDays: bounded.length,
    totalClosed: calls.length,
    calls,
  };
}
