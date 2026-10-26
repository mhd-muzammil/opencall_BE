import type { DayReportCell, DayReportRange } from "./payrollClient.js";

/**
 * The Day Report, Live Tracking's third tab: what the day panel says about each
 * engineer-day, for many at once.
 *
 * Payroll is asked a day at a time, a few days at once, as the KM Report asks
 * for km, so no single request does a month's work. This puts the days back
 * together: one row per engineer, in the order asked, every day in it.
 */

/** The most days the page may ask for at once; Payroll refuses more too. */
export const MAX_DAY_REPORT_DAYS = 31;

export interface DayReportAnswer {
  configured: true;
  days: string[];
  engineers: { engineer_id: number; days: Record<string, DayReportCell> }[];
}

/**
 * One answer out of a day's answers. `answers[i]` is Payroll's for `days[i]`.
 * An engineer Payroll left out of a day's answer -- one this login may not see
 * -- is left out of the whole report rather than shown with holes.
 */
export function mergeDayReports(
  days: string[],
  answers: DayReportRange[],
  engineerIds: number[],
): DayReportAnswer {
  const byEngineer = new Map<number, Record<string, DayReportCell>>();
  answers.forEach((answer, index) => {
    const day = days[index];
    if (!day) return;
    for (const row of answer.engineers) {
      const cell = row.days[day];
      if (!cell) continue;
      const cells = byEngineer.get(row.engineer_id) ?? {};
      cells[day] = cell;
      byEngineer.set(row.engineer_id, cells);
    }
  });
  const engineers = engineerIds
    .map((engineerId) => ({ engineer_id: engineerId, days: byEngineer.get(engineerId) ?? {} }))
    .filter((row) => days.every((day) => row.days[day] !== undefined));
  return { configured: true, days, engineers };
}
