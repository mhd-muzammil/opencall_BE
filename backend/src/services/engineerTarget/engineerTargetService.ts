import {
  computeEngineerProductivity,
  type ProductivityReportRow,
} from "@opencall/shared";
import {
  findProductivityRowsByReportId,
  type ProductivityPersistedRow,
} from "../../repositories/dailyCallPlanReportRepository.js";
import { findReportDaysInRange } from "../../repositories/engineerTargetRepository.js";

/**
 * Engineer Target — how each engineer is tracking against the standing close target.
 *
 * The counts are NOT a new calculation: every day in the range is replayed through the
 * SAME `computeEngineerProductivity` the live dashboard and the Final-EOD freeze use, so a
 * day's "closed" here can never disagree with the Engineer Productivity page. This service
 * only adds the target arithmetic on top.
 *
 * Read-only, and entirely self-contained — no existing service, repository or calculation
 * is modified.
 */

/** The standing target, same for every engineer. */
export const DAILY_CLOSE_TARGET = 7;
/** Working days in a target month. */
export const WORKING_DAYS_PER_MONTH = 25;
/** 25 working days x 7 closes. */
export const MONTHLY_CLOSE_TARGET = DAILY_CLOSE_TARGET * WORKING_DAYS_PER_MONTH;

/**
 * The shared-calc row shape from a persisted report row. Intentionally duplicated from the
 * EOD service's private mapper rather than exporting that one — this feature must not edit
 * an existing file, and a six-field literal is cheaper to keep honest than a refactor.
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

/** One engineer's closes on one working day. */
export interface EngineerDayClose {
  date: string;
  closed: number;
}

export interface EngineerTargetRow {
  engineer: string;
  regionCode: string;
  /** Closes on the most recent day in the range (the "today" column). */
  todayClosed: number;
  /** Total closes across every day in the range. */
  periodClosed: number;
  /** Days in the range this engineer actually appears on the plan. */
  daysWorked: number;
  /** Per-day breakdown, oldest first — drives the sparkline / day list. */
  days: EngineerDayClose[];
}

export interface EngineerTargetResponse {
  fromDate: string;
  toDate: string;
  /** The most recent report date in the range; the "today" figures come from it. */
  latestDate: string | null;
  /** Number of report days actually found in the range. */
  reportDays: number;
  dailyTarget: number;
  monthlyTarget: number;
  workingDaysPerMonth: number;
  rows: EngineerTargetRow[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(value: string, field: string): void {
  if (!ISO_DATE.test(value)) {
    throw new Error(`${field} must be a YYYY-MM-DD date`);
  }
}

/**
 * Per-engineer close counts for every report day in the range.
 *
 * One query per day (the shared calculation needs a day's rows), which is fine for a
 * month-sized range on an on-demand analytics view; the range is clamped to 62 days so a
 * mistyped filter can never fan out unbounded.
 */
export async function getEngineerTargetProgress(input: {
  fromDate: string;
  toDate: string;
  /** ASP codes the caller may see; null = unrestricted. */
  allowedAspCodes: Set<string> | null;
}): Promise<EngineerTargetResponse> {
  const { fromDate, toDate, allowedAspCodes } = input;
  assertIsoDate(fromDate, "fromDate");
  assertIsoDate(toDate, "toDate");

  const days = await findReportDaysInRange(fromDate, toDate);
  const bounded = days.slice(0, 62).sort((a, b) => a.reportDate.localeCompare(b.reportDate));

  const byEngineer = new Map<string, EngineerTargetRow>();

  for (const day of bounded) {
    const persisted = await findProductivityRowsByReportId(day.reportId);
    const productivity = computeEngineerProductivity(persisted.map(toProductivityRow));

    for (const entry of productivity.list) {
      const regionCode = entry.regionCode ?? "";
      if (allowedAspCodes && !allowedAspCodes.has(regionCode.toUpperCase())) {
        continue;
      }

      const key = `${entry.name}::${regionCode}`;
      let row = byEngineer.get(key);
      if (!row) {
        row = {
          engineer: entry.name,
          regionCode,
          todayClosed: 0,
          periodClosed: 0,
          daysWorked: 0,
          days: [],
        };
        byEngineer.set(key, row);
      }

      row.days.push({ date: day.reportDate, closed: entry.closed });
      row.periodClosed += entry.closed;
      // "Worked" means the engineer was on that day's plan at all, not that they closed
      // something — a day with 0 closes still counts against the target.
      row.daysWorked += 1;
    }
  }

  const latestDate = bounded.length > 0 ? bounded[bounded.length - 1]!.reportDate : null;
  for (const row of byEngineer.values()) {
    row.todayClosed =
      row.days.find((day) => day.date === latestDate)?.closed ?? 0;
  }

  const rows = [...byEngineer.values()].sort(
    (a, b) => b.periodClosed - a.periodClosed || a.engineer.localeCompare(b.engineer),
  );

  return {
    fromDate,
    toDate,
    latestDate,
    reportDays: bounded.length,
    dailyTarget: DAILY_CLOSE_TARGET,
    monthlyTarget: MONTHLY_CLOSE_TARGET,
    workingDaysPerMonth: WORKING_DAYS_PER_MONTH,
    rows,
  };
}
