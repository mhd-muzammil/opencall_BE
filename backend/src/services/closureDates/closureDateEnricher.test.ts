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
  closedSyntheticRow = false,
) {
  return {
    reportDate,
    rows: rows.map((output) => ({
      output,
      carryForward: { closedSyntheticRow },
    })),
  };
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

  it("overlays an OLD closure on a row that has actually closed", async () => {
    // A call that has left the WIP is closed; the vendor status is the only thing that
    // says whether it was completed ("WO Closed") or abandoned ("Closed - Canceled"),
    // and that matters at any age because only completions are billable.
    mocks.loadClosureDateLookup.mockResolvedValue({
      byWoId: new Map([
        [
          "WO-1",
          closure({
            closedOnIso: "2026-06-14",
            closedOn: "14-06-2026",
            status: "Closed - Canceled",
          }),
        ],
      ]),
      byCaseId: new Map(),
    });

    const report = await enrichReportWithClosureDates(
      reportWith(
        [{ "Ticket ID": "WO-1", "Flex Status": "Request to Cancel" }],
        "2026-08-01",
        true,
      ),
    );

    expect(report.rows[0]?.output["Flex Status"]).toBe("Closed - Canceled");
    expect(report.rows[0]?.output["Flex Status (WIP)"]).toBe("Request to Cancel");
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

describe("enrichReportWithClosureDates — one closure, one row", () => {
  /**
   * The production shapes from 2026-08-28. Several work orders share a Case ID —
   * a revisit filed as "-1", or a repeat call raised as a brand new WO against the
   * same case — and the Case-id fallback stamped one closure onto all of them.
   */
  function lookupFor(record: ClosureRecord) {
    return {
      byWoId: new Map([[record.woId, record]]),
      byCaseId: new Map([[record.caseId, record]]),
    };
  }

  it("gives a revisit's closure to the work order that owns it, not the -1 row", async () => {
    const record = closure({ woId: "WO-035260625", caseId: "5162554102" });
    mocks.loadClosureDateLookup.mockResolvedValue(lookupFor(record));

    const report = reportWith(
      [
        { "Ticket ID": "WO-035260625", "Case ID": "5162554102" },
        { "Ticket ID": "WO-035260625-1", "Case ID": "5162554102" },
      ],
      "2026-08-01",
      true,
    );
    const enriched = await enrichReportWithClosureDates(report);

    expect(enriched.rows[0]!.output["Flex Status"]).toBe("WO Closed");
    // The revisit is a separate job. Counting it closed reported two completions
    // for one closure — 22 phantom completions in the 25 Jul–24 Aug cycle.
    expect(enriched.rows[1]!.output).not.toHaveProperty("Flex Status");
    expect(enriched.rows[1]!.output).not.toHaveProperty("Case Closed Date");
  });

  it("gives a repeat call's closure to one row when three share the case", async () => {
    const record = closure({ woId: "WO-035340079", caseId: "5162524657" });
    mocks.loadClosureDateLookup.mockResolvedValue(lookupFor(record));

    // The owning WO is deliberately in the MIDDLE — the WO-id pass runs across every
    // row before the fallback, so position must not decide who gets the closure.
    const report = reportWith(
      [
        { "Ticket ID": "WO-035252057", "Case ID": "5162524657" },
        { "Ticket ID": "WO-035340079", "Case ID": "5162524657" },
        { "Ticket ID": "WO-035372074", "Case ID": "5162524657" },
      ],
      "2026-08-01",
      true,
    );
    const enriched = await enrichReportWithClosureDates(report);

    const stamped = enriched.rows.filter((r) => "Flex Status" in r.output);
    expect(stamped).toHaveLength(1);
    expect(stamped[0]!.output["Ticket ID"]).toBe("WO-035340079");
  });

  it("still reaches a row through Case id when no row owns the WO id", async () => {
    // The fallback's reason for existing: a closure filed under a Case id we never
    // saw as a WO id would otherwise never reach its row.
    const record = closure({ woId: "WO-NOT-IN-REPORT", caseId: "5163770707" });
    mocks.loadClosureDateLookup.mockResolvedValue(lookupFor(record));

    const report = reportWith(
      [{ "Ticket ID": "WO-035606423", "Case ID": "5163770707" }],
      "2026-08-01",
      true,
    );
    const enriched = await enrichReportWithClosureDates(report);

    expect(enriched.rows[0]!.output["Flex Status"]).toBe("WO Closed");
  });

  it("does not let two case-only rows both claim one closure", async () => {
    const record = closure({ woId: "WO-NOT-IN-REPORT", caseId: "5162345454" });
    mocks.loadClosureDateLookup.mockResolvedValue(lookupFor(record));

    const report = reportWith(
      [
        { "Ticket ID": "WO-035273280", "Case ID": "5162345454" },
        { "Ticket ID": "WO-035405862", "Case ID": "5162345454" },
      ],
      "2026-08-01",
      true,
    );
    const enriched = await enrichReportWithClosureDates(report);

    expect(enriched.rows.filter((r) => "Flex Status" in r.output)).toHaveLength(1);
  });
});

describe("an ambiguous Case Id is not guessed at", () => {
  /**
   * Since migration 065 a case may hold several closures. The Case-id fallback then has
   * no way to know which one a row means, and the old last-write-wins picked whichever
   * the query happened to return last — that is how a Vellore row ended up stamped with
   * a Kanchipuram closure.
   *
   * `loadClosureDateLookup` therefore leaves an ambiguous case out of `byCaseId`
   * entirely. These tests pin the enricher's half of that contract.
   */
  it("still overlays a row whose own WO id matches", async () => {
    const owner = closure({ woId: "WO-035340079", caseId: "5162524657" });
    mocks.loadClosureDateLookup.mockResolvedValue({
      byWoId: new Map([[owner.woId, owner]]),
      byCaseId: new Map(), // ambiguous case withheld by the repository
    });

    const report = reportWith(
      [{ "Ticket ID": "WO-035340079", "Case ID": "5162524657" }],
      "2026-08-01",
      true,
    );
    const enriched = await enrichReportWithClosureDates(report);
    expect(enriched.rows[0]!.output["Flex Status"]).toBe("WO Closed");
  });

  it("leaves a sibling row unstamped rather than guessing a closure for it", async () => {
    const owner = closure({ woId: "WO-035340079", caseId: "5162524657" });
    mocks.loadClosureDateLookup.mockResolvedValue({
      byWoId: new Map([[owner.woId, owner]]),
      byCaseId: new Map(),
    });

    // Shares the case but is a different job; its own closure is a separate record.
    const report = reportWith(
      [{ "Ticket ID": "WO-035252057", "Case ID": "5162524657" }],
      "2026-08-01",
      true,
    );
    const enriched = await enrichReportWithClosureDates(report);
    expect(enriched.rows[0]!.output).not.toHaveProperty("Flex Status");
    expect(enriched.rows[0]!.output).not.toHaveProperty("Case Closed Date");
  });
});
