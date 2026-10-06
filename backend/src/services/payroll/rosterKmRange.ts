import type { RosterEngineer } from "./payrollClient.js";

/**
 * Kilometres over a period, for the Engineer Productivity table.
 *
 * Payroll records distance PER DAY and has no range question, so a month or a
 * bill cycle is answered by asking it once per day and adding the days up per
 * engineer. That is the honest figure for the row: the calls beside it are also
 * the sum of that engineer's days.
 */

/** A bill cycle is the widest thing the page asks for; two months is headroom. */
export const MAX_KM_RANGE_DAYS = 62;

/** Payroll is asked this many days at a time, not 31 at once. */
export const KM_RANGE_CONCURRENCY = 4;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Today in IST, which is the day Payroll files a fix under. */
export function todayIstIso(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * Every day from `from` to `to` inclusive, stopping at today: a future day has
 * no distance and is a wasted round trip. Null when the bounds are not two ISO
 * days, are reversed, or span more than MAX_KM_RANGE_DAYS.
 */
export function daysInKmRange(from: string, to: string, today: string): string[] | null {
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) return null;
  const last = to < today ? to : today;
  const days: string[] = [];
  for (let day = from; day <= last; day = addDays(day, 1)) {
    days.push(day);
    if (days.length > MAX_KM_RANGE_DAYS) return null;
  }
  return days;
}

export interface EngineerKmTotal {
  engineer_id: number | null;
  engineer_name: string;
  distance_km: number;
  /** Days in the period with any distance at all. */
  days_tracked: number;
}

/** Adds each engineer's days together, keyed on the register name we asked under. */
export function sumRosterKm(days: RosterEngineer[][]): EngineerKmTotal[] {
  const totals = new Map<string, EngineerKmTotal>();
  for (const rows of days) {
    for (const row of rows) {
      const km = Number(row.distance_km) || 0;
      const current = totals.get(row.engineer_name) ?? {
        engineer_id: null,
        engineer_name: row.engineer_name,
        distance_km: 0,
        days_tracked: 0,
      };
      current.distance_km += km;
      if (km > 0) current.days_tracked += 1;
      if (current.engineer_id == null && row.engineer_id != null) {
        current.engineer_id = row.engineer_id;
      }
      totals.set(row.engineer_name, current);
    }
  }
  return [...totals.values()].map((total) => ({
    ...total,
    distance_km: Math.round(total.distance_km * 100) / 100,
  }));
}

/** Runs `work` over `items`, at most `limit` at a time, keeping their order. */
export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(lanes);
  return results;
}
