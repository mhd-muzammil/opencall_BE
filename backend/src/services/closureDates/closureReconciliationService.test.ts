import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bucketReconciliation,
  eveningFirstStatus,
  isClosedHereStatus,
  reconcileClosuresForDate,
  type ClosedHereRow,
  type FlexClosureRow,
} from "./closureReconciliationService.js";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../config/database.js", () => ({
  query: mocks.query,
  pool: { connect: vi.fn() },
}));

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
});

const NOW = Date.parse("2026-07-31T18:00:00+05:30");

function here(overrides: Partial<ClosedHereRow>): ClosedHereRow {
  return {
    ticketId: "WO-1",
    caseId: "C-1",
    aspCode: "ASPS01461",
    rtplStatus: "Scheduled",
    previousRtplStatus: null,
    eveningRtplStatus: "Case-Closed",
    closedAt: "2026-07-31T10:00:00+05:30",
    ...overrides,
  };
}

function flex(overrides: Partial<FlexClosureRow>): FlexClosureRow {
  return {
    woId: "WO-1",
    caseId: "C-1",
    aspCode: "ASPS01461",
    status: "WO Closed",
    closureDate: "31-07-2026",
    ...overrides,
  };
}

describe("isClosedHereStatus", () => {
  it("counts genuine completions only", () => {
    expect(isClosedHereStatus("Case-Closed")).toBe(true);
    expect(isClosedHereStatus("case closed")).toBe(true);
    expect(isClosedHereStatus("WO-closed")).toBe(true);
    expect(isClosedHereStatus("wo closed")).toBe(true);
  });

  it("leaves cancellations and intents out — they are attended work, not a close", () => {
    expect(isClosedHereStatus("Closed-cancellation")).toBe(false);
    expect(isClosedHereStatus("Need to Close")).toBe(false);
    expect(isClosedHereStatus("Need to Cancel")).toBe(false);
    expect(isClosedHereStatus("Under Cancellation")).toBe(false);
    expect(isClosedHereStatus("")).toBe(false);
  });
});

describe("eveningFirstStatus", () => {
  it("prefers the Evening entry once one exists", () => {
    expect(
      eveningFirstStatus({
        rtplStatus: "Scheduled",
        previousRtplStatus: null,
        eveningRtplStatus: "Case-Closed",
      }),
    ).toBe("Case-Closed");
  });

  it("falls back to Morning when Evening is blank or a placeholder", () => {
    expect(
      eveningFirstStatus({
        rtplStatus: "Scheduled",
        previousRtplStatus: null,
        eveningRtplStatus: "",
      }),
    ).toBe("Scheduled");
    expect(
      eveningFirstStatus({
        rtplStatus: "Scheduled",
        previousRtplStatus: null,
        eveningRtplStatus: "Manual entry required",
      }),
    ).toBe("Scheduled");
  });

  it("falls back to yesterday's status when Morning is a placeholder too", () => {
    expect(
      eveningFirstStatus({
        rtplStatus: "Manual entry required",
        previousRtplStatus: "WO-closed",
        eveningRtplStatus: "",
      }),
    ).toBe("WO-closed");
  });
});

describe("bucketReconciliation", () => {
  it("splits a mixed day into the three buckets", () => {
    const result = bucketReconciliation({
      date: "2026-07-31",
      closedHere: [
        // Closed here AND in Flex.
        here({ ticketId: "WO-1", caseId: "C-1" }),
        // Closed here, Flex has nothing.
        here({ ticketId: "WO-2", caseId: "C-2", closedAt: "2026-07-31T12:00:00+05:30" }),
        // Not closed here at all — must not appear anywhere as "ours".
        here({ ticketId: "WO-3", caseId: "C-3", eveningRtplStatus: "Part Order Pending" }),
      ],
      flexClosures: [
        flex({ woId: "WO-1", caseId: "C-1" }),
        // Flex closed it; our evening status says Part Order Pending.
        flex({ woId: "WO-3", caseId: "C-3", status: "Closed - Canceled", closureDate: "" }),
        // Flex closed something the day's report does not contain at all.
        flex({ woId: "WO-9", caseId: "C-9", aspCode: "ASPS01462" }),
      ],
      nowMs: NOW,
    });

    expect(result.counts).toEqual({
      matched: 1,
      closedHereNotInFlex: 1,
      closedInFlexNotHere: 2,
    });
    expect(result.matched[0]?.ticketId).toBe("WO-1");
    expect(result.closedHereNotInFlex[0]?.ticketId).toBe("WO-2");
    expect(result.closedInFlexNotHere.map((r) => r.ticketId).sort()).toEqual([
      "WO-3",
      "WO-9",
    ]);
  });

  it("carries the closure status so a cancellation is distinguishable", () => {
    const result = bucketReconciliation({
      date: "2026-07-31",
      closedHere: [],
      flexClosures: [
        flex({ woId: "WO-3", status: "Closed - Canceled", closureDate: "" }),
      ],
      nowMs: NOW,
    });

    expect(result.closedInFlexNotHere[0]).toMatchObject({
      closureStatus: "Closed - Canceled",
      closureDate: "",
    });
  });

  it("reports how long Flex has been behind us", () => {
    const result = bucketReconciliation({
      date: "2026-07-31",
      closedHere: [here({ ticketId: "WO-2", closedAt: "2026-07-31T12:00:00+05:30" })],
      flexClosures: [],
      nowMs: NOW,
    });

    expect(result.closedHereNotInFlex[0]?.hoursSinceClosedHere).toBe(6);
  });

  it("matches on Case id when the WO id does not line up", () => {
    const result = bucketReconciliation({
      date: "2026-07-31",
      closedHere: [here({ ticketId: "WO-7", caseId: "C-7" })],
      flexClosures: [flex({ woId: "", caseId: "C-7" })],
      nowMs: NOW,
    });

    expect(result.counts.matched).toBe(1);
    expect(result.counts.closedInFlexNotHere).toBe(0);
  });

  it("normalises keys the same way the report enricher does", () => {
    const result = bucketReconciliation({
      date: "2026-07-31",
      closedHere: [here({ ticketId: " wo-8 ", caseId: "" })],
      flexClosures: [flex({ woId: "WO-8", caseId: "" })],
      nowMs: NOW,
    });

    expect(result.counts.matched).toBe(1);
  });

  it("counts a same-day closure but not one closed on an earlier day", () => {
    // Both look identical by status. The earlier-day closure is a synthetic row that
    // gets re-stamped into every later report forever, so only the SQL visibility
    // filter can tell them apart — see the loadDayRows test below.
    const result = bucketReconciliation({
      date: "2026-07-31",
      closedHere: [here({ ticketId: "WO-TODAY" })],
      flexClosures: [],
      nowMs: NOW,
    });

    expect(result.counts.closedHereNotInFlex).toBe(1);
  });

  it("is empty on a day with nothing on either side", () => {
    const result = bucketReconciliation({
      date: "2026-07-31",
      closedHere: [here({ eveningRtplStatus: "Actionable" })],
      flexClosures: [],
      nowMs: NOW,
    });

    expect(result.counts).toEqual({
      matched: 0,
      closedHereNotInFlex: 0,
      closedInFlexNotHere: 0,
    });
  });
});

describe("reconcileClosuresForDate — the day's row set", () => {
  it("applies Records-page visibility, or every past closure recounts every day", async () => {
    await reconcileClosuresForDate({ date: "2026-07-31", allowedAspCodes: null });

    const [sql] = mocks.query.mock.calls[0] as [string, unknown[]];
    const flat = sql.replace(/\s+/g, " ");

    // A call closed by an EARLIER day's upload keeps its synthetic row and is
    // re-stamped into every later report forever. Without this it would count as
    // "closed here" again every single day and closedHereNotInFlex would grow without
    // bound — which is exactly what it did on the first prod deploy.
    expect(flat).toContain(
      "AND (rows.change_type IS DISTINCT FROM 'CLOSED' OR rows.same_day_closed)",
    );
    // Request-to-Cancel rows are off the Records page, so they are not ours to close.
    expect(flat).toContain("<> 'request to cancel'");
    expect(flat).toContain("AND NOT rows.is_excluded");
  });

  it("scopes both halves to the caller's ASP codes", async () => {
    await reconcileClosuresForDate({
      date: "2026-07-31",
      allowedAspCodes: ["ASPS01461"],
      aspCode: "ASPS01461",
    });

    expect(mocks.query).toHaveBeenCalledTimes(2);
    // The scope is the LAST parameter of both queries; the two before it are the day bounds.
    for (const [, params] of mocks.query.mock.calls) {
      const list = params as unknown[];
      expect(list[list.length - 1]).toEqual(["ASPS01461"]);
    }
  });

  it("asks for a single day when no end date is given", async () => {
    // `BETWEEN d AND d` is exactly `= d`, so a caller that knows nothing about ranges gets
    // the query it always got rather than one that merely behaves the same.
    await reconcileClosuresForDate({ date: "2026-07-31", allowedAspCodes: null });

    for (const [, params] of mocks.query.mock.calls) {
      expect(params as unknown[]).toEqual(
        expect.arrayContaining(["2026-07-31", "2026-07-31"]),
      );
    }
  });

  it("asks for the whole period when an end date is given", async () => {
    await reconcileClosuresForDate({
      date: "2026-07-01",
      toDate: "2026-07-31",
      allowedAspCodes: null,
    });

    for (const [sql, params] of mocks.query.mock.calls as Array<[string, unknown[]]>) {
      expect(sql.replace(/\s+/g, " ")).toContain("BETWEEN $1::date AND $2::date");
      expect(params[0]).toBe("2026-07-01");
      expect(params[1]).toBe("2026-07-31");
    }
  });
});
