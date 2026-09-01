/**
 * The target cycle, which is the one thing in this sync that is arithmetic
 * rather than a forward of somebody else's number — and it got it wrong first
 * time round. The first cut counted from the 1st of the calendar month, which
 * on the 1st is a single day, reads as everybody having closed nothing, and is
 * a month out of step with the period the target is actually set over.
 *
 * Mirrors the frontend's lib/targetCycle.ts. If these two ever disagree, the
 * engineer's phone and the Target tab show different month-to-date figures,
 * which is the exact failure this whole feature exists to prevent.
 */
import { describe, expect, it } from "vitest";

import { targetCycleFor } from "./syncEngineerScorecards.js";

describe("targetCycleFor", () => {
  it("runs 24th of the previous month to 25th of this one", () => {
    // The case in the screenshot: on 1 Sep the tab reads "24 Aug - 25 Sep".
    expect(targetCycleFor("2026-09-01")).toEqual({ from: "2026-08-24", to: "2026-09-25" });
  });

  it("is the same cycle all the way through it", () => {
    for (const day of ["2026-08-24", "2026-08-31", "2026-09-10", "2026-09-25"]) {
      const cycle = targetCycleFor(day);
      expect(cycle.to.slice(0, 7)).toBe(day >= "2026-09-01" ? "2026-09" : "2026-08");
    }
  });

  it("names a cycle by the month it ends in, so 24 Aug belongs to the August cycle", () => {
    expect(targetCycleFor("2026-08-24")).toEqual({ from: "2026-07-24", to: "2026-08-25" });
  });

  it("rolls back into the previous year in January", () => {
    expect(targetCycleFor("2027-01-05")).toEqual({ from: "2026-12-24", to: "2027-01-25" });
  });

  it("still reports the cycle just closed between the 26th and month end", () => {
    // Deliberate, and what the Target tab does: currentTargetCycle keys off the
    // month you are in, so 26 Sep still shows 24 Aug - 25 Sep.
    expect(targetCycleFor("2026-09-26")).toEqual({ from: "2026-08-24", to: "2026-09-25" });
  });

  it("zero-pads single-digit months on both ends", () => {
    expect(targetCycleFor("2026-03-02")).toEqual({ from: "2026-02-24", to: "2026-03-25" });
  });
});
