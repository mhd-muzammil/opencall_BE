/**
 * "Sync engineer scorecards to Payroll".
 *
 * An engineer opening the Payroll app should see the same Assigned / Attended /
 * Closed the office sees on Engineer Productivity, and how they are tracking
 * against the close target for today and for the month. Two systems computing
 * that separately would eventually disagree, and the engineer would have no way
 * to tell which one was lying — so nothing is computed here. This reads exactly
 * what the Engineer Productivity view is served from (`getReportProductivity`,
 * frozen snapshot for CLOSED regions) and exactly what the Engineer Target view
 * is served from (`getEngineerTargetProgress`), and forwards them.
 *
 * Deliberately a separate file from syncAssignedCases: the case sync is the one
 * an engineer's whole day depends on, and it has been broken in production
 * before. This must never be able to take it down, so it is its own call, its
 * own failure, and its own log line.
 *
 * Strictly READ-ONLY w.r.t. OpenCall. No-op (never throws) when the Payroll
 * integration isn't configured.
 */
import { findEngineerContactByName } from "../../repositories/engineerRepository.js";
import { getReportProductivity } from "../productivity/eodService.js";
import {
  DAILY_CLOSE_TARGET,
  MONTHLY_CLOSE_TARGET,
  getEngineerTargetProgress,
} from "../engineerTarget/engineerTargetService.js";
import { HttpError } from "../../utils/httpError.js";
import {
  isPayrollConfigured,
  pushEngineerScorecards,
  type PayrollScorecardResult,
  type PayrollScorecardRow,
} from "./payrollClient.js";

export interface ScorecardSyncResult {
  configured: boolean;
  workingDate: string;
  engineers: number;
  payroll?: PayrollScorecardResult;
  message?: string;
}

/**
 * Month-to-date is a per-day replay across the target cycle (about 32 days). The scheduler ticks
 * every two minutes; recomputing the whole month each tick would be 30x the
 * work for a number that moves a handful of times a day. Cached for ten
 * minutes, keyed by the range, and the cache is a single entry because there is
 * only ever one range in flight.
 */
const MTD_CACHE_MS = 10 * 60 * 1000;
let mtdCache: { key: string; at: number; byEngineer: Map<string, number> } | null = null;

/**
 * The target cycle a date falls in: the 24th of the month before, to the 25th of
 * the month the date is in.
 *
 * Engineer targets are NOT counted over a calendar month. The first cut of this
 * sync used the 1st, which on the 1st of a month is a single day and reads as
 * everybody having closed nothing -- a month out of step with the period the
 * target is actually set over, and disagreeing with the very page it exists to
 * agree with.
 *
 * The rule is the frontend's `lib/targetCycle.ts` (currentTargetCycle /
 * cycleEndingIn); duplicated here rather than shared because that module lives
 * in the frontend package and this must not reach across into it. Keep the two
 * in step: a cycle is named by the month it ENDS in.
 *
 * `to` is in the future for most of the month, and that is correct -- the cycle
 * has not finished. getEngineerTargetProgress only counts report days that
 * exist, so a date nobody has reached yet adds no days and changes no number.
 * Between the 26th and month end this therefore reports the cycle that has just
 * closed, exactly as the Target tab does.
 */
export function targetCycleFor(isoDate: string): { from: string; to: string } {
  const year = Number(isoDate.slice(0, 4));
  const monthIndex = Number(isoDate.slice(5, 7)) - 1;
  // Through Date rather than monthIndex - 1, so January rolls back into
  // December of the year before instead of producing month -1.
  const start = new Date(year, monthIndex - 1, 24);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    from: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-24`,
    to: `${year}-${pad(monthIndex + 1)}-25`,
  };
}

/** Engineer name -> closes in the current target cycle. Empty if it cannot be read. */
async function monthToDateCloses(workingDate: string): Promise<Map<string, number>> {
  const cycle = targetCycleFor(workingDate);
  const fromDate = cycle.from;
  const key = `${fromDate}..${cycle.to}`;
  if (mtdCache && mtdCache.key === key && Date.now() - mtdCache.at < MTD_CACHE_MS) {
    return mtdCache.byEngineer;
  }

  const byEngineer = new Map<string, number>();
  try {
    // allowedAspCodes null: this is a service sync, not a user request, so it
    // must see every region. Payroll then shows each engineer only their own.
    const progress = await getEngineerTargetProgress({
      fromDate,
      toDate: cycle.to,
      allowedAspCodes: null,
    });
    for (const row of progress.rows) {
      const name = row.engineer.trim();
      // The same engineer can appear under more than one region code; the app
      // shows one person one number, so sum them the way the name merge below
      // sums the day's counts.
      byEngineer.set(name, (byEngineer.get(name) ?? 0) + row.periodClosed);
    }
  } catch (error) {
    // A month-to-date figure is the least important thing here. Losing it must
    // not cost the engineer today's numbers, so this degrades to zero rather
    // than aborting the push.
    console.warn(
      `[payroll] scorecards: month-to-date unavailable for ${key}:`,
      error instanceof Error ? error.message : error,
    );
    return byEngineer;
  }

  mtdCache = { key, at: Date.now(), byEngineer };
  return byEngineer;
}

export async function syncEngineerScorecardsForDate(
  workingDate: string,
): Promise<ScorecardSyncResult> {
  if (!isPayrollConfigured()) {
    return {
      configured: false,
      workingDate,
      engineers: 0,
      message: "Payroll integration is not configured (set PAYROLL_API_URL/USER/PASSWORD).",
    };
  }

  let productivity;
  try {
    productivity = await getReportProductivity(workingDate);
  } catch (error) {
    // Only a rejected DATE is a benign "nothing to sync"; a DB fault must not
    // be reported as "no report", which reads as normal and hides an outage.
    if (error instanceof HttpError) {
      return {
        configured: true,
        workingDate,
        engineers: 0,
        message: `Cannot read the productivity view for ${workingDate}: ${error.message}`,
      };
    }
    throw error;
  }

  // Merged across regions by name — the same aggregation the productivity table
  // does, and the same one syncAssignedCases uses, so the Assigned count here
  // cannot disagree with the number of cases that engineer was pushed.
  const totals = new Map<string, { assigned: number; attended: number; closed: number }>();
  for (const region of productivity.regions) {
    for (const engineer of region.productivity.list) {
      const name = engineer.name.trim();
      if (!name) continue;
      const row = totals.get(name) ?? { assigned: 0, attended: 0, closed: 0 };
      row.assigned += engineer.assigned;
      row.attended += engineer.attended;
      row.closed += engineer.closed;
      totals.set(name, row);
    }
  }

  if (totals.size === 0) {
    return {
      configured: true,
      workingDate,
      engineers: 0,
      message: `No engineers on the ${workingDate} plan.`,
    };
  }

  const monthClosed = await monthToDateCloses(workingDate);

  const rows: PayrollScorecardRow[] = [];
  for (const [name, counts] of totals) {
    // Email and phone are Payroll's reliable match keys; name alone is a last
    // resort there. Same resolution the case sync uses, so an engineer whose
    // cases arrive will have their numbers arrive too.
    const contact = await findEngineerContactByName(name);
    const row: PayrollScorecardRow = {
      engineer_name: name,
      assigned: counts.assigned,
      attended: counts.attended,
      closed: counts.closed,
      month_closed: monthClosed.get(name) ?? 0,
    };
    if (contact?.email) row.engineer_email = contact.email;
    if (contact?.phone) row.engineer_phone = contact.phone;
    rows.push(row);
  }

  const payroll = await pushEngineerScorecards({
    asOf: workingDate,
    dailyTarget: DAILY_CLOSE_TARGET,
    monthlyTarget: MONTHLY_CLOSE_TARGET,
    rows,
  });

  return { configured: true, workingDate, engineers: rows.length, payroll };
}
