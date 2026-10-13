import { describe, expect, it } from "vitest";
import type { RosterEngineer } from "./payrollClient.js";
import { kmByDay } from "./rosterKmDays.js";
import { sumRosterKm } from "./rosterKmRange.js";

function row(
  name: string,
  km: number,
  extra: Partial<RosterEngineer> = {},
): RosterEngineer {
  return {
    engineer_name: name,
    engineer_id: 1,
    matched: true,
    branch: "Chennai",
    department: "FSE",
    distance_km: km,
    ...extra,
  } as RosterEngineer;
}

const DAYS = ["2026-09-25", "2026-09-26", "2026-09-27"];

describe("kmByDay", () => {
  it("keeps each day's km apart, per engineer, on the day it was travelled", () => {
    const result = kmByDay(DAYS, [
      [row("Arun", 12.5, { engineer_id: 7 }), row("Bala", 0, { engineer_id: 8, branch: "Salem" })],
      [row("Arun", 0, { engineer_id: 7 }), row("Bala", 40.25, { engineer_id: 8, branch: "Salem" })],
      [row("Arun", 33.17, { engineer_id: 7 }), row("Bala", 1.03, { engineer_id: 8, branch: "Salem" })],
    ]);
    expect(result).toEqual([
      {
        engineer_id: 7,
        engineer_name: "Arun",
        matched: true,
        branch: "Chennai",
        department: "FSE",
        days: { "2026-09-25": 12.5, "2026-09-26": 0, "2026-09-27": 33.17 },
        distance_km: 45.67,
        days_tracked: 2,
      },
      {
        engineer_id: 8,
        engineer_name: "Bala",
        matched: true,
        branch: "Salem",
        department: "FSE",
        days: { "2026-09-25": 0, "2026-09-26": 40.25, "2026-09-27": 1.03 },
        distance_km: 41.28,
        days_tracked: 2,
      },
    ]);
  });

  it("totals exactly what /roster/km gives Engineer Productivity", () => {
    const perDay = [
      [row("Arun", 10.11), row("Chitra", 3.33, { engineer_id: 9 })],
      [row("Arun", 20.22), row("Chitra", 0.01, { engineer_id: 9 })],
      [row("Arun", 30.33), row("Chitra", 99.99, { engineer_id: 9 })],
    ];
    const totals = new Map(sumRosterKm(perDay).map((t) => [t.engineer_name, t]));
    for (const result of kmByDay(DAYS, perDay)) {
      const total = totals.get(result.engineer_name)!;
      expect(result.distance_km).toBe(total.distance_km);
      expect(result.days_tracked).toBe(total.days_tracked);
      // And the row's cells add up to its total.
      const cells = Object.values(result.days).reduce((sum, km) => sum + km, 0);
      expect(Math.round(cells * 100) / 100).toBe(result.distance_km);
    }
  });

  it("lists every day of the period, with 0 where the roster has nothing", () => {
    const [arun] = kmByDay(DAYS, [[row("Arun", 5)], [], [row("Arun", 2)]]);
    expect(Object.keys(arun!.days)).toEqual(DAYS);
    expect(arun!.days["2026-09-26"]).toBe(0);
  });

  it("an engineer Payroll never resolved stays unmatched with no km", () => {
    const unmatched = { engineer_id: null, matched: false, branch: null, department: null };
    const [vendor] = kmByDay(DAYS, [[row("Vendor Ravi", 0, unmatched)], [row("Vendor Ravi", 0, unmatched)]]);
    expect(vendor).toMatchObject({ engineer_id: null, matched: false, distance_km: 0, days_tracked: 0 });
  });

  it("labels a row Payroll has no branch for with the register's region", () => {
    const [ravi] = kmByDay(
      DAYS,
      [[row("Ravi", 4, { branch: null })]],
      new Map([["Ravi", "Hosur"]]),
    );
    expect(ravi!.branch).toBe("Hosur");
  });

  it("the latest day's branch wins when it changed during the period", () => {
    const [arun] = kmByDay(DAYS, [[row("Arun", 1, { branch: "Chennai" })], [row("Arun", 1, { branch: "Vellore" })]]);
    expect(arun!.branch).toBe("Vellore");
  });

  it("is in name order, whatever order Payroll answered in", () => {
    const names = kmByDay(DAYS, [[row("zara", 1), row("Arun", 1), row("bala", 1)]]).map((r) => r.engineer_name);
    expect(names).toEqual(["Arun", "bala", "zara"]);
  });

  it("an empty period is an empty report", () => {
    expect(kmByDay([], [])).toEqual([]);
  });
});
