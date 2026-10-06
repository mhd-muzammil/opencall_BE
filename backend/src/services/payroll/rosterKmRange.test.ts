import { describe, expect, it } from "vitest";
import type { RosterEngineer } from "./payrollClient.js";
import {
  MAX_KM_RANGE_DAYS,
  daysInKmRange,
  mapLimited,
  sumRosterKm,
  todayIstIso,
} from "./rosterKmRange.js";

function row(name: string, km: number, id: number | null = 1): RosterEngineer {
  return { engineer_name: name, engineer_id: id, distance_km: km } as RosterEngineer;
}

describe("daysInKmRange", () => {
  it("lists a bill cycle day by day, both ends included", () => {
    const days = daysInKmRange("2026-08-25", "2026-09-24", "2026-12-31");
    expect(days).toHaveLength(31);
    expect(days?.[0]).toBe("2026-08-25");
    expect(days?.at(-1)).toBe("2026-09-24");
  });

  it("stops at today rather than asking about days that have not happened", () => {
    expect(daysInKmRange("2026-10-04", "2026-10-24", "2026-10-06")).toEqual([
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
    ]);
  });

  it("refuses reversed, malformed, and over-wide ranges", () => {
    expect(daysInKmRange("2026-10-06", "2026-10-01", "2026-12-31")).toBeNull();
    expect(daysInKmRange("06-10-2026", "2026-10-06", "2026-12-31")).toBeNull();
    expect(daysInKmRange("2026-01-01", "2026-12-31", "2026-12-31")).toBeNull();
  });

  it("allows exactly the maximum", () => {
    const from = "2026-01-01";
    const to = new Date(Date.UTC(2026, 0, MAX_KM_RANGE_DAYS)).toISOString().slice(0, 10);
    expect(daysInKmRange(from, to, "2026-12-31")).toHaveLength(MAX_KM_RANGE_DAYS);
  });
});

describe("todayIstIso", () => {
  it("is already tomorrow in IST at 19:00 UTC", () => {
    expect(todayIstIso(new Date("2026-10-06T19:00:00Z"))).toBe("2026-10-07");
  });
});

describe("sumRosterKm", () => {
  it("adds each engineer's days and counts the days they moved", () => {
    const totals = sumRosterKm([
      [row("Mohan", 35.7), row("samim", 0)],
      [row("Mohan", 10.25), row("samim", 12)],
    ]);
    expect(totals).toEqual([
      { engineer_id: 1, engineer_name: "Mohan", distance_km: 45.95, days_tracked: 2 },
      { engineer_id: 1, engineer_name: "samim", distance_km: 12, days_tracked: 1 },
    ]);
  });

  it("keeps the payroll id from whichever day resolved it", () => {
    const [total] = sumRosterKm([[row("Vignesh", 0, null)], [row("Vignesh", 5, 42)]]);
    expect(total?.engineer_id).toBe(42);
  });
});

describe("mapLimited", () => {
  it("never runs more than the limit at once and keeps order", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
});
