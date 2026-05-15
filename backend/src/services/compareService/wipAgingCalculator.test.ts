import { describe, expect, it } from "vitest";
import { calculateWipAging } from "./wipAgingCalculator.js";

// Helper: build a Date from an IST date/time string like "2026-05-07 20:27:05"
// IST is UTC+05:30 so we subtract 5h30m to get UTC.
function ist(dateStr: string): Date {
  // dateStr: "YYYY-MM-DD HH:mm:ss"
  const utc = new Date(dateStr + "+05:30");
  return utc;
}

describe("calculateWipAging", () => {
  it("returns null for null/undefined/empty input", () => {
    expect(calculateWipAging(null)).toBeNull();
    expect(calculateWipAging(undefined)).toBeNull();
    expect(calculateWipAging("")).toBeNull();
  });

  it("returns null for unparseable dates", () => {
    expect(calculateWipAging("not-a-date")).toBeNull();
    expect(calculateWipAging("foobar")).toBeNull();
  });

  it("returns '0' when reference is before creation", () => {
    const created = ist("2026-05-14T16:00:00");
    const now = ist("2026-05-13T10:00:00");
    expect(calculateWipAging(created, now)).toBe("0");
  });

  it("returns '0' for same day", () => {
    const created = ist("2026-05-14T08:00:00");
    const now = ist("2026-05-14T16:00:00");
    expect(calculateWipAging(created, now)).toBe("0");
  });

  // ── The exact example from the user ──
  // Created: 07-05-2026 08:27:05 PM IST  (Wednesday)
  // Now:     14-05-2026 04:00:00 PM IST  (Wednesday)
  //
  // Calendar:
  //   Wed 07 (creation day – day 0)
  //   Thu 08 → 1
  //   Fri 09 → 2
  //   Sat 10 → 3
  //   Sun 11 → SKIP
  //   Mon 12 → 4
  //   Tue 13 → 5
  //   Wed 14 → would be 6, but 4:00 PM < 8:27 PM → stays 5
  //
  // Expected: 5
  it("user example: created 07-May 8:27 PM, now 14-May 4:00 PM → 5", () => {
    const created = ist("2026-05-07T20:27:05");
    const now = ist("2026-05-14T16:00:00");
    expect(calculateWipAging(created, now)).toBe("5");
  });

  // Same example, but now is 8:28 PM → past the creation time → 6
  it("user example: created 07-May 8:27 PM, now 14-May 8:28 PM → 6", () => {
    const created = ist("2026-05-07T20:27:05");
    const now = ist("2026-05-14T20:28:00");
    expect(calculateWipAging(created, now)).toBe("6");
  });

  // Exactly at creation time-of-day → should count as completed → 6
  it("user example: created 07-May 8:27:05 PM, now 14-May 8:27:05 PM → 6", () => {
    const created = ist("2026-05-07T20:27:05");
    const now = ist("2026-05-14T20:27:05");
    expect(calculateWipAging(created, now)).toBe("6");
  });

  // Sunday is excluded
  it("skips Sunday: Sat to Mon is only 1 business day", () => {
    // Created Saturday 10-May 10:00 AM, now Monday 12-May 11:00 AM
    const created = ist("2026-05-10T10:00:00");
    const now = ist("2026-05-12T11:00:00");
    // Sat 10 → day 0
    // Sun 11 → skip
    // Mon 12 → 1 (and 11 AM > 10 AM, so time condition met)
    expect(calculateWipAging(created, now)).toBe("1");
  });

  // Multiple Sundays
  it("handles a span with two Sundays", () => {
    // Created Fri 02-May 09:00 IST, now Wed 14-May 10:00 IST
    // Fri 02 → day 0
    // Sat 03 → 1
    // Sun 04 → skip
    // Mon 05 → 2
    // Tue 06 → 3
    // Wed 07 → 4
    // Thu 08 → 5
    // Fri 09 → 6
    // Sat 10 → 7
    // Sun 11 → skip
    // Mon 12 → 8
    // Tue 13 → 9
    // Wed 14 → 10 (10 AM > 9 AM → complete)
    const created = ist("2026-05-02T09:00:00");
    const now = ist("2026-05-14T10:00:00");
    expect(calculateWipAging(created, now)).toBe("10");
  });

  it("next day but time not reached", () => {
    // Created Mon 12-May 6 PM, now Tue 13-May 2 PM → 0 (time not reached)
    const created = ist("2026-05-12T18:00:00");
    const now = ist("2026-05-13T14:00:00");
    expect(calculateWipAging(created, now)).toBe("0");
  });

  it("next day and time reached", () => {
    // Created Mon 12-May 6 PM, now Tue 13-May 7 PM → 1
    const created = ist("2026-05-12T18:00:00");
    const now = ist("2026-05-13T19:00:00");
    expect(calculateWipAging(created, now)).toBe("1");
  });

  it("works with ISO string input", () => {
    // Same as user example but as ISO string
    const created = "2026-05-07T14:57:05.000Z"; // 8:27:05 PM IST
    const now = ist("2026-05-14T16:00:00");
    expect(calculateWipAging(created, now)).toBe("5");
  });

  it("created on Sunday itself", () => {
    // Created Sunday 11-May 10 AM, now Monday 12-May 11 AM
    // Sun 11 → day 0
    // Mon 12 → 1 (11 AM > 10 AM → time reached)
    const created = ist("2026-05-11T10:00:00");
    const now = ist("2026-05-12T11:00:00");
    expect(calculateWipAging(created, now)).toBe("1");
  });
});
