import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseClosureRows,
  toIsoDate,
  toIstTimestamp,
} from "./closureDateImportService.js";
import { classifyClosureStatus } from "./closureStatusClassify.js";

/**
 * The Excel serial for an IST wall-clock timestamp — exactly what the workbook stores.
 * Serial 0 is 1899-12-30, and the fraction is the time of day.
 */
function serial(
  y: number,
  m: number,
  d: number,
  H = 0,
  M = 0,
  S = 0,
): number {
  const days = Date.UTC(y, m - 1, d) / 86_400_000 + 25_569;
  return days + (H * 3600 + M * 60 + S) / 86_400;
}

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    "Ticket No": "",
    "Case Id": "",
    Status: "",
    "Status Remarks": "",
    "Closure Date": "",
    "Failure Code": "",
    "Resolution comments": "",
    "Work Location": "",
    "ASP Name": "",
    "Activity Time": "",
    ...overrides,
  };
}

describe("classifyClosureStatus", () => {
  it("tests CANCEL before CLOSED — 'Closed - Canceled' is never a completion", () => {
    // The literal contains BOTH words. Getting the order wrong counts 9 of every 74
    // real rows as genuine closures.
    expect(classifyClosureStatus("Closed - Canceled")).toBe("cancelled");
    expect(classifyClosureStatus("Closed - Cancelled")).toBe("cancelled");
    expect(classifyClosureStatus("WO Closed")).toBe("closed");
    expect(classifyClosureStatus("Closed")).toBe("closed");
    expect(classifyClosureStatus("In Progress")).toBe("other");
    expect(classifyClosureStatus("")).toBe("other");
  });
});

describe("toIsoDate / toIstTimestamp — timezone", () => {
  const originalTz = process.env.TZ;

  // Production runs the API and worker in containers that used to default to UTC. The
  // old implementation built the date from a JS Date's LOCAL getters, so real rows with
  // Activity Times of 00:31 and 05:01 IST rolled back to the previous day.
  beforeAll(() => {
    process.env.TZ = "UTC";
  });
  afterAll(() => {
    process.env.TZ = originalTz;
  });

  it("keeps a 00:31 activity time on its own day", () => {
    expect(toIsoDate(serial(2026, 7, 31, 0, 31))).toBe("2026-07-31");
  });

  it("keeps a 05:01 activity time on its own day", () => {
    expect(toIsoDate(serial(2026, 7, 31, 5, 1))).toBe("2026-07-31");
  });

  it("stamps the wall clock with the IST offset rather than reinterpreting it", () => {
    expect(toIstTimestamp(serial(2026, 7, 31, 0, 31))).toBe(
      "2026-07-31T00:31:00+05:30",
    );
  });

  it("reads DD-MM-YYYY and YYYY-MM-DD text cells too", () => {
    expect(toIsoDate("31-07-2026")).toBe("2026-07-31");
    expect(toIsoDate("31/07/2026 00:31")).toBe("2026-07-31");
    expect(toIsoDate("2026-07-31 05:01:00")).toBe("2026-07-31");
    expect(toIsoDate("")).toBeNull();
    expect(toIsoDate("not a date")).toBeNull();
  });
});

describe("parseClosureRows — collapsing part-order rows", () => {
  it("collapses a 5-part work order to one record and keeps the non-blank Failure Code", () => {
    // The real report emits one row per PART ORDER. Four of these five are part lines
    // with no closure data; the fifth is the row that actually closed the call.
    const rows = [
      row({ "Ticket No": "WO-1", "Case Id": "C-1", Status: "WO Closed", "Activity Time": serial(2026, 7, 31, 9, 0) }),
      row({ "Ticket No": "WO-1", "Case Id": "C-1", Status: "WO Closed", "Activity Time": serial(2026, 7, 31, 9, 5) }),
      row({
        "Ticket No": "WO-1",
        "Case Id": "C-1",
        Status: "WO Closed",
        "Closure Date": serial(2026, 7, 31),
        "Failure Code": "FC-77",
        "Work Location": "aspS01461",
        "Activity Time": serial(2026, 7, 31, 9, 10),
      }),
      row({ "Ticket No": "WO-1", "Case Id": "C-1", Status: "WO Closed", "Activity Time": serial(2026, 7, 31, 9, 20) }),
      // Deliberately LAST and with the latest Activity Time: the old "last occurrence
      // wins" backwards scan picked this one and lost the Failure Code.
      row({ "Ticket No": "WO-1", "Case Id": "C-1", Status: "WO Closed", "Activity Time": serial(2026, 7, 31, 9, 30) }),
    ];

    const parsed = parseClosureRows(rows, "AUTO");

    expect(parsed.totalRows).toBe(5);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({
      woId: "WO-1",
      caseId: "C-1",
      closureDate: "2026-07-31",
      closedOn: "2026-07-31",
      failureCode: "FC-77",
      workLocation: "ASPS01461",
      importSource: "AUTO",
    });
  });

  it("breaks a tie on the later Activity Time when neither row has a Closure Date", () => {
    const parsed = parseClosureRows(
      [
        row({ "Ticket No": "WO-2", "Failure Code": "OLD", "Activity Time": serial(2026, 7, 31, 8, 0) }),
        row({ "Ticket No": "WO-2", "Failure Code": "NEW", "Activity Time": serial(2026, 7, 31, 18, 0) }),
      ],
      "MANUAL",
    );

    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]?.failureCode).toBe("NEW");
  });

  it("stores a cancellation that has no Closure Date, dated from its Activity Time", () => {
    // 9 of 74 rows in the real samples are exactly this. They ARE closed in Flex.
    const parsed = parseClosureRows(
      [
        row({
          "Ticket No": "WO-3",
          Status: "Closed - Canceled",
          "Closure Date": "",
          "Activity Time": serial(2026, 7, 31, 0, 31),
        }),
      ],
      "AUTO",
    );

    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({
      woId: "WO-3",
      closureDate: null,
      closedOn: "2026-07-31",
      closureStatus: "Closed - Canceled",
    });
  });

  it("skips a row with neither a Ticket No nor a Case Id", () => {
    const parsed = parseClosureRows(
      [row({ Status: "WO Closed" }), row({ "Ticket No": "WO-4" })],
      "MANUAL",
    );

    expect(parsed.skippedNoKey).toBe(1);
    expect(parsed.records).toHaveLength(1);
  });

  it("groups a row that only carries a Case Id under that Case Id", () => {
    const parsed = parseClosureRows(
      [
        row({ "Case Id": "C-9", Status: "WO Closed", "Activity Time": serial(2026, 7, 31, 8, 0) }),
        row({ "Case Id": "C-9", Status: "WO Closed", "Activity Time": serial(2026, 7, 31, 9, 0) }),
      ],
      "MANUAL",
    );

    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]?.woId).toBe("");
    expect(parsed.records[0]?.caseId).toBe("C-9");
  });
});
