import { describe, expect, it } from "vitest";
import { parseReportsRange, payslipMonthsFor } from "./reportsHub.js";

describe("parseReportsRange", () => {
  it("accepts a cycle", () => {
    expect(parseReportsRange("2026-10-25", "2026-11-24")).toEqual({ ok: true, from: "2026-10-25", to: "2026-11-24" });
  });
  it("refuses bad, reversed and over-long ranges", () => {
    expect(parseReportsRange("2026-02-30", "2026-03-01").ok).toBe(false);
    expect(parseReportsRange(undefined, "2026-03-01").ok).toBe(false);
    expect(parseReportsRange("2026-03-02", "2026-03-01").ok).toBe(false);
    expect(parseReportsRange("2026-10-01", "2026-11-01").ok).toBe(false);
  });
});

describe("payslipMonthsFor", () => {
  it("files the 25th onwards under the next month", () => {
    expect(payslipMonthsFor("2026-10-25", "2026-11-24")).toEqual([{ month: 11, year: 2026 }]);
    expect(payslipMonthsFor("2026-10-10", "2026-11-05")).toEqual([
      { month: 10, year: 2026 },
      { month: 11, year: 2026 },
    ]);
  });
  it("rolls December's cycle into January", () => {
    expect(payslipMonthsFor("2026-12-26", "2026-12-28")).toEqual([{ month: 1, year: 2027 }]);
  });
});
