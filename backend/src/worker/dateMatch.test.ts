import { describe, expect, it } from "vitest";
import { sameCalendarDay } from "./dateMatch.js";

/**
 * FieldEZ echoes a date back without the leading zero on the month, so a literal
 * string compare warned on every single cycle. A warning that always fires is one
 * nobody reads — and it would have hidden a date that genuinely failed to apply.
 */
describe("sameCalendarDay", () => {
  it("accepts the unpadded month FieldEZ actually returns", () => {
    expect(sameCalendarDay("2026-8-22", "2026-08-22")).toBe(true);
    expect(sameCalendarDay("2026-8-2", "2026-08-02")).toBe(true);
  });

  it("still rejects a genuinely different day", () => {
    expect(sameCalendarDay("2026-08-21", "2026-08-22")).toBe(false);
    expect(sameCalendarDay("2026-07-22", "2026-08-22")).toBe(false);
    expect(sameCalendarDay("2025-08-22", "2026-08-22")).toBe(false);
  });

  it("tolerates a different separator", () => {
    expect(sameCalendarDay("2026/8/22", "2026-08-22")).toBe(true);
  });

  it("falls back to an exact compare when a side is unparseable", () => {
    // Garbage in the field must still warn rather than be assumed equal.
    expect(sameCalendarDay("", "2026-08-22")).toBe(false);
    expect(sameCalendarDay("not a date", "2026-08-22")).toBe(false);
    expect(sameCalendarDay("same", "same")).toBe(true);
  });
});
