import { describe, expect, it } from "vitest";
import { MAX_RECONCILIATION_DAYS, daysBetween } from "./closureDateController.js";

/**
 * The bound these pin exists because of a real outage. On 2026-08-27 the API's ten database
 * connections were all taken — two report generations running at once — and everything else
 * began failing with "timeout exceeded when trying to connect": login, the flex summary, the
 * health check. Reconciliation reads every report row in its period and window-functions
 * over them, so an unbounded date picker is a second way to reach that same place, from a
 * screen anybody can open.
 *
 * An off-by-one in a guard is a guard that lets through exactly the request it was written
 * to stop, so the boundary is checked from both sides.
 */

describe("daysBetween", () => {
  it("counts a single day as no span at all", () => {
    expect(daysBetween("2026-08-27", "2026-08-27")).toBe(0);
  });

  it("counts consecutive days as one", () => {
    expect(daysBetween("2026-08-27", "2026-08-28")).toBe(1);
  });

  it("counts across a month boundary", () => {
    expect(daysBetween("2026-07-31", "2026-08-01")).toBe(1);
    expect(daysBetween("2026-07-01", "2026-07-31")).toBe(30);
  });

  it("counts across a year boundary", () => {
    expect(daysBetween("2025-12-25", "2026-01-05")).toBe(11);
  });

  it("counts a leap day", () => {
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
  });

  it("is negative for a backwards range rather than pretending it is short", () => {
    // The controller refuses backwards ranges before it measures them, but a length guard
    // that silently read -60 as "within the limit" would be a hole waiting for the day the
    // order of those two checks is changed.
    expect(daysBetween("2026-08-27", "2026-06-27")).toBeLessThan(0);
  });

  it("is zero rather than NaN for something that is not a date", () => {
    // NaN compares false against every bound, so a guard reading it would wave the request
    // through. Zero is refused by nothing and measured as nothing.
    expect(daysBetween("not-a-date", "2026-08-27")).toBe(0);
    expect(daysBetween("2026-08-27", "")).toBe(0);
  });
});

describe("the reconciliation period limit", () => {
  it("allows a whole month, which is the question people ask", () => {
    expect(daysBetween("2026-08-01", "2026-08-31")).toBeLessThanOrEqual(MAX_RECONCILIATION_DAYS);
    expect(daysBetween("2026-07-01", "2026-07-31")).toBeLessThanOrEqual(MAX_RECONCILIATION_DAYS);
  });

  it("allows exactly the limit and refuses one day more", () => {
    expect(daysBetween("2026-08-01", "2026-09-01")).toBe(31);
    expect(daysBetween("2026-08-01", "2026-09-01")).toBeLessThanOrEqual(MAX_RECONCILIATION_DAYS);
    expect(daysBetween("2026-08-01", "2026-09-02")).toBeGreaterThan(MAX_RECONCILIATION_DAYS);
  });

  it("refuses the quarter that would hold a connection for minutes", () => {
    expect(daysBetween("2026-06-01", "2026-08-31")).toBeGreaterThan(MAX_RECONCILIATION_DAYS);
  });

  it("is the same number the date picker enforces", () => {
    // ClosedCallsDashboardView caps the To field at From + RECON_MAX_DAYS. If these ever
    // drift, the picker offers a day the server rejects.
    expect(MAX_RECONCILIATION_DAYS).toBe(31);
  });
});
