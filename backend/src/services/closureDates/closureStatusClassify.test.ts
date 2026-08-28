import { describe, expect, it } from "vitest";
import {
  CLOSURE_STATUS_MATCHERS,
  classifyClosureStatus,
  tallyClosureStatuses,
} from "./closureStatusClassify.js";

/**
 * Statuses seen in the real Flex Closure ASP Report workbooks. "Closed - Canceled"
 * is the whole reason this classification is order-sensitive.
 */
const REAL_STATUSES = [
  "WO Closed",
  "Closed",
  "Closed - Canceled",
  "Closed - Cancelled",
  "Under Cancellation",
  "Open",
  "",
];

describe("classifyClosureStatus", () => {
  it("reads a completion as closed", () => {
    expect(classifyClosureStatus("WO Closed")).toBe("closed");
    expect(classifyClosureStatus("Closed")).toBe("closed");
  });

  it("reads 'Closed - Canceled' as cancelled, not closed", () => {
    // The trap: the string contains BOTH words. Testing CLOSE first would have
    // scored every cancellation as a billable completion.
    expect(classifyClosureStatus("Closed - Canceled")).toBe("cancelled");
    expect(classifyClosureStatus("Closed - Cancelled")).toBe("cancelled");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(classifyClosureStatus("  wo closed  ")).toBe("closed");
    expect(classifyClosureStatus("CLOSED - CANCELED")).toBe("cancelled");
  });

  it("puts blanks and unknowns in other", () => {
    expect(classifyClosureStatus("")).toBe("other");
    expect(classifyClosureStatus(null)).toBe("other");
    expect(classifyClosureStatus(undefined)).toBe("other");
    expect(classifyClosureStatus("Awaiting Parts")).toBe("other");
  });

  it("tallies a mixed batch", () => {
    expect(tallyClosureStatuses(REAL_STATUSES)).toEqual({
      closed: 2,
      cancelled: 3, // incl. "Under Cancellation"
      other: 2,
    });
  });
});

describe("CLOSURE_STATUS_MATCHERS", () => {
  it("tests CANCEL before CLOSE", () => {
    // The repository builds its SQL CASE from this list in order. Reordering it
    // silently reclassifies every cancellation as a completion on the cards.
    expect(CLOSURE_STATUS_MATCHERS.map((m) => m.group)).toEqual([
      "cancelled",
      "closed",
    ]);
  });

  it("drives classifyClosureStatus, so a SQL CASE built from it agrees", () => {
    // Emulates the generated `CASE WHEN ... LIKE '%X%' THEN g ... ELSE 'other' END`
    // against the same list, proving the two forms cannot disagree.
    const asSqlCase = (status: string) => {
      const upper = status.toUpperCase();
      for (const m of CLOSURE_STATUS_MATCHERS) {
        if (upper.includes(m.substring)) return m.group;
      }
      return "other";
    };
    for (const status of REAL_STATUSES) {
      expect(asSqlCase(status)).toBe(classifyClosureStatus(status));
    }
  });

  it("uses substrings that are safe to inline into SQL", () => {
    // They are interpolated into a LIKE pattern rather than bound as parameters,
    // which is only acceptable while they stay plain uppercase letters.
    for (const m of CLOSURE_STATUS_MATCHERS) {
      expect(m.substring).toMatch(/^[A-Z]+$/);
    }
  });
});
