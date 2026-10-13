import type { RosterEngineer } from "./payrollClient.js";
import { sumRosterKm } from "./rosterKmRange.js";

/**
 * Kilometres per engineer PER DAY over a period, for the KM Report.
 *
 * The same day-by-day roster answers that /roster/km adds up for Engineer
 * Productivity, kept apart instead of summed: one row per engineer, one figure
 * per day. Each day's figure is the one the live tracking board shows for that
 * engineer on that day, and each row's total is sumRosterKm's -- so the report,
 * the board and the Productivity table can never disagree.
 */

export interface EngineerKmDays {
  engineer_id: number | null;
  /** The name in our register, as the board shows it. */
  engineer_name: string;
  /** Resolved in Payroll on at least one day of the period. */
  matched: boolean;
  /** Payroll's branch, else the register's region. */
  branch: string | null;
  department: string | null;
  /** km per ISO day, for every day of the period; 0 when nothing was travelled. */
  days: Record<string, number>;
  /** The period's total, exactly as /roster/km reports it. */
  distance_km: number;
  /** Days in the period with any distance at all. */
  days_tracked: number;
}

const round2 = (km: number) => Math.round(km * 100) / 100;

/**
 * One row per register name. `perDay[i]` is the roster for `days[i]`.
 * `regionByName` labels a row Payroll has no branch for, as the board does.
 */
export function kmByDay(
  days: string[],
  perDay: RosterEngineer[][],
  regionByName: Map<string, string | null> = new Map(),
): EngineerKmDays[] {
  const rows = new Map<string, EngineerKmDays>();
  perDay.forEach((roster, index) => {
    const day = days[index];
    if (!day) return;
    for (const entry of roster) {
      let row = rows.get(entry.engineer_name);
      if (!row) {
        row = {
          engineer_id: null,
          engineer_name: entry.engineer_name,
          matched: false,
          branch: null,
          department: null,
          days: Object.fromEntries(days.map((d) => [d, 0])),
          distance_km: 0,
          days_tracked: 0,
        };
        rows.set(entry.engineer_name, row);
      }
      row.days[day] = round2((row.days[day] ?? 0) + (Number(entry.distance_km) || 0));
      if (entry.matched) row.matched = true;
      // The latest day's answer wins, as it would on today's board.
      if (entry.branch) row.branch = entry.branch;
      if (entry.department) row.department = entry.department;
    }
  });

  const totals = new Map(sumRosterKm(perDay).map((total) => [total.engineer_name, total]));
  return [...rows.values()]
    .map((row) => {
      const total = totals.get(row.engineer_name);
      return {
        ...row,
        engineer_id: total?.engineer_id ?? null,
        branch: row.branch ?? regionByName.get(row.engineer_name) ?? null,
        distance_km: total?.distance_km ?? 0,
        days_tracked: total?.days_tracked ?? 0,
      };
    })
    .sort((a, b) => a.engineer_name.localeCompare(b.engineer_name, undefined, { sensitivity: "base" }));
}
