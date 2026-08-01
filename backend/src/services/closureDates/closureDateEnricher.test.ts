import { beforeEach, describe, expect, it, vi } from "vitest";
import { enrichReportWithClosureDates } from "./closureDateEnricher.js";
import type { ClosureRecord } from "../../repositories/caseClosureDateRepository.js";

const mocks = vi.hoisted(() => ({
  loadClosureDateLookup: vi.fn(),
  loadCustomerFeedbackLookup: vi.fn(),
}));

vi.mock("../../repositories/caseClosureDateRepository.js", () => ({
  loadClosureDateLookup: mocks.loadClosureDateLookup,
  normalizeKey: (v: unknown) => String(v ?? "").trim().toUpperCase(),
}));

vi.mock("../../repositories/customerFeedbackRepository.js", () => ({
  loadCustomerFeedbackLookup: mocks.loadCustomerFeedbackLookup,
}));

function closure(overrides: Partial<ClosureRecord> = {}): ClosureRecord {
  return {
    woId: "WO-1",
    caseId: "C-1",
    closureDate: "01-08-2026",
    closedOn: "01-08-2026",
    closedOnIso: "2026-08-01",
    status: "WO Closed",
    statusRemarks: "closed by engineer",
    failureCode: "",
    workLocation: "ASPS01461",
    ...overrides,
  };
}

function reportWith(
  rows: Array<Record<string, unknown>>,
  reportDate = "2026-08-01",
) {
  return { reportDate, rows: rows.map((output) => ({ output })) };
}

beforeEach(() => {
  mocks.loadCustomerFeedbackLookup.mockReset().mockResolvedValue({
    byWoId: new Map(),
    byCaseId: new Map(),
  });
  mocks.loadClosureDateLookup.mockReset().mockResolvedValue({
    byWoId: new Map([["WO-1", closure()]]),
    byCaseId: new Map([["C-1", closure()]]),
  });
});

describe("enrichReportWithClosureDates — Flex Status overlay", () => {
  it("overlays a closure recorded for this report's own day", async () => {
    const report = await enrichReportWithClosureDates(
      reportWith([{ "Ticket ID": "WO-1", "Flex Status": "SSC Pending" }]),
    );

    expect(report.rows[0]?.output["Flex Status"]).toBe("WO Closed");
    expect(report.rows[0]?.output["Flex Status (WIP)"]).toBe("SSC Pending");
    expect(report.rows[0]?.output["Status Remarks"]).toBe("closed by engineer");
  });

  it("does NOT overlay a closure from an earlier day", async () => {
    // `case_closure_dates` is a running archive with no notion of a work order being
    // reopened, so a WO closed weeks ago stays in it forever. Overlaying on any match
    // branded live calls as "WO Closed" purely because they had once been closed —
    // 16 open rows on 2026-08-01 when only 3 had actually closed that day.
    mocks.loadClosureDateLookup.mockResolvedValue({
      byWoId: new Map([
        ["WO-1", closure({ closedOnIso: "2026-06-14", closedOn: "14-06-2026" })],
      ]),
      byCaseId: new Map(),
    });

    const report = await enrichReportWithClosureDates(
      reportWith([{ "Ticket ID": "WO-1", "Flex Status": "SSC Pending" }]),
    );

    expect(report.rows[0]?.output["Flex Status"]).toBe("SSC Pending");
    expect(report.rows[0]?.output["Flex Status (WIP)"]).toBeUndefined();
    expect(report.rows[0]?.output["Status Remarks"]).toBeUndefined();
    // The historical closure date is still useful and is still stamped.
    expect(report.rows[0]?.output["Case Closed Date"]).toBe("14-06-2026");
  });

  it("shows an older report the closures of ITS day, not today's", async () => {
    mocks.loadClosureDateLookup.mockResolvedValue({
      byWoId: new Map([
        ["WO-1", closure({ closedOnIso: "2026-06-14", closedOn: "14-06-2026" })],
      ]),
      byCaseId: new Map(),
    });

    const report = await enrichReportWithClosureDates(
      reportWith([{ "Ticket ID": "WO-1", "Flex Status": "SSC Pending" }], "2026-06-14"),
    );

    expect(report.rows[0]?.output["Flex Status"]).toBe("WO Closed");
  });

  it("leaves the cell alone when the report has no date", async () => {
    const report = await enrichReportWithClosureDates(
      reportWith([{ "Ticket ID": "WO-1", "Flex Status": "SSC Pending" }], ""),
    );

    expect(report.rows[0]?.output["Flex Status"]).toBe("SSC Pending");
  });

  it("matches on Case ID when the Ticket ID does not line up", async () => {
    const report = await enrichReportWithClosureDates(
      reportWith([{ "Ticket ID": "WO-OTHER", "Case ID": "C-1", "Flex Status": "Open" }]),
    );

    expect(report.rows[0]?.output["Flex Status"]).toBe("WO Closed");
  });

  it("leaves unmatched rows completely untouched", async () => {
    const report = await enrichReportWithClosureDates(
      reportWith([{ "Ticket ID": "WO-NOPE", "Flex Status": "Problem Resolution" }]),
    );

    expect(report.rows[0]?.output["Flex Status"]).toBe("Problem Resolution");
    expect(report.rows[0]?.output["Flex Status (WIP)"]).toBeUndefined();
    expect(report.rows[0]?.output["Case Closed Date"]).toBeUndefined();
  });

  it("serves the report as-is when the lookup throws", async () => {
    mocks.loadClosureDateLookup.mockRejectedValue(new Error("db down"));

    const report = await enrichReportWithClosureDates(
      reportWith([{ "Ticket ID": "WO-1", "Flex Status": "SSC Pending" }]),
    );

    expect(report.rows[0]?.output["Flex Status"]).toBe("SSC Pending");
  });
});
