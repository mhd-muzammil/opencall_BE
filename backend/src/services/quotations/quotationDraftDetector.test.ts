import { istTodayIso } from "@opencall/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratedDailyCallPlanReport } from "../../types/reportGeneration.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  findUnraisedDraftKeys: vi.fn(),
  insertQuotationDraft: vi.fn(),
}));

// Nothing here can reach a database: the Flex lookup and the drafts table are stand-ins.
vi.mock("../../config/database.js", () => ({ query: mocks.query }));
vi.mock("../../repositories/quotationDraftRepository.js", () => ({
  findUnraisedDraftKeys: mocks.findUnraisedDraftKeys,
  insertQuotationDraft: mocks.insertQuotationDraft,
}));

import {
  pickQuotationDraftCandidates,
  queueQuotationDraftsFromReport,
  raiseQuotationDrafts,
  settleQuotationDrafts,
  toDraftInput,
} from "./quotationDraftDetector.js";

/** One report row, as much of it as the detector reads. */
function row(enriched: Record<string, unknown>, closed = false, sameDayClosed = false) {
  return {
    carryForward: { closedSyntheticRow: closed, sameDayClosedRow: sameDayClosed },
    enriched: {
      ticket_id: "WO-036404653",
      case_id: "5166159539",
      wo_otc_code: "01-Trade",
      flex_status: "Visit Estimate",
      rtpl_status: "",
      work_location: "VELLORE",
      customer_name: "Likhitha",
      contact: "9000000001",
      customer_mail: "",
      product: "HP Smart Tank 581 All-in-One",
      product_serial_no: "CN43F65KWK",
      part: "",
      ...enriched,
    },
    output: {},
  };
}

function report(rows: unknown[], reportDate = istTodayIso()) {
  return { reportId: "6f1f7b1e-0000-4000-8000-000000000001", reportDate, rows } as unknown as GeneratedDailyCallPlanReport;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.insertQuotationDraft.mockResolvedValue(true);
});

describe("which work orders wait for approval", () => {
  it("raises a Visit quotation for 01-Trade at Visit Estimate, and a Part one at Visit Quote To Customer", () => {
    const picked = pickQuotationDraftCandidates(
      report([
        row({ ticket_id: "WO-036404653", flex_status: "Visit Estimate" }),
        row({ ticket_id: "WO-036403359", flex_status: "Visit Quote To Customer" }),
      ]),
    );

    expect(picked.map((c) => [c.kind, c.ticketId, c.ticketKey])).toEqual([
      ["VISIT", "WO-036404653", "WO036404653"],
      ["PART", "WO-036403359", "WO036403359"],
    ]);
  });

  it("reads the code and the status however the export spaces or cases them", () => {
    const picked = pickQuotationDraftCandidates(
      report([row({ wo_otc_code: " 01 - Trade ", flex_status: "visit  quote to CUSTOMER " })]),
    );

    expect(picked.map((c) => c.kind)).toEqual(["PART"]);
  });

  it("raises nothing for any other code or status", () => {
    const picked = pickQuotationDraftCandidates(
      report([
        // Warranty work is not quoted.
        row({ wo_otc_code: "05K-Extended Warranty" }),
        // Seen in a real export: a quote status on a field-install order, not 01-Trade.
        row({ wo_otc_code: "05F-Comp Field Install", flex_status: "Trade - Quote Generated" }),
        // Close words, different statuses.
        row({ flex_status: "Visitation Rejected" }),
        row({ flex_status: "Visitation Accepted" }),
        row({ flex_status: "" }),
        // A blank code is "Manual Entry Required" on the sheet and null underneath.
        row({ wo_otc_code: null }),
      ]),
    );

    expect(picked).toEqual([]);
  });

  it("goes by Flex Status, never by the team's RTPL status of the same name", () => {
    const picked = pickQuotationDraftCandidates(
      report([row({ flex_status: "Parts Pending", rtpl_status: "Visit Quote to Customer" })]),
    );

    expect(picked).toEqual([]);
  });

  it("leaves out a call that has closed, though its row still carries Visit Estimate", () => {
    expect(pickQuotationDraftCandidates(report([row({}, true)]))).toEqual([]);
  });

  it("raises a call closed on a same-day re-upload, which the Records page still lists", () => {
    expect(pickQuotationDraftCandidates(report([row({}, true, true)])).map((c) => c.kind)).toEqual(["VISIT"]);
  });

  it("raises one per work order when the export lists it once per part", () => {
    const picked = pickQuotationDraftCandidates(
      report([row({ part: "SPS-TOP COVER" }), row({ part: "SPS-ADF ROLLER" })]),
    );

    expect(picked).toHaveLength(1);
  });

  it("skips a row with no work order to key it on", () => {
    expect(pickQuotationDraftCandidates(report([row({ ticket_id: " " })]))).toEqual([]);
  });
});

describe("what a waiting quotation is raised with", () => {
  const [candidate] = pickQuotationDraftCandidates(report([row({ customer_mail: "Manual Entry Required" })]));

  it("takes the customer and the unit from Flex's own record", () => {
    const input = toDraftInput(
      candidate!,
      {
        case_id: "5166159539",
        customer_name: "Likhitha R",
        customer_address: "12, Gandhi Road",
        customer_city: "Vellore",
        customer_state: "Tamil Nadu",
        customer_pincode: "632001",
        customer_phone: "9000000002",
        customer_email: "likhitha@example.com",
        product_name: "HP Smart Tank 581 All-in-One Printer",
        product_number: "4A8D4A",
        product_serial: "CN43F65KWK",
      },
      "6f1f7b1e-0000-4000-8000-000000000001",
    );

    expect(input).toMatchObject({
      kind: "VISIT",
      ticketKey: "WO036404653",
      ticketId: "WO-036404653",
      caseId: "5166159539",
      customerName: "Likhitha R",
      customerAddress: "12, Gandhi Road",
      customerCity: "Vellore",
      customerState: "Tamil Nadu",
      customerPincode: "632001",
      customerPhone: "9000000002",
      // The report's column said "Manual Entry Required", which is not an address.
      customerEmail: "likhitha@example.com",
      productDescription: "HP Smart Tank 581 All-in-One Printer",
      modelNo: "4A8D4A",
      serialNo: "CN43F65KWK",
      workLocation: "VELLORE",
      flexStatus: "Visit Estimate",
    });
  });

  it("falls back to the report where Flex has nothing", () => {
    const input = toDraftInput(candidate!, undefined, null);

    expect(input).toMatchObject({
      customerName: "Likhitha",
      customerPhone: "9000000001",
      productDescription: "HP Smart Tank 581 All-in-One",
      serialNo: "CN43F65KWK",
      customerAddress: "",
      customerEmail: "",
      reportId: null,
    });
  });

  it("prefers the mail address the team typed into the report", () => {
    const [typed] = pickQuotationDraftCandidates(report([row({ customer_mail: "correct@example.com" })]));
    const input = toDraftInput(typed!, { customer_email: "old@example.com" } as never, null);

    expect(input.customerEmail).toBe("correct@example.com");
  });
});

describe("raising them from a report", () => {
  it("raises only the ones not raised before, with Flex's details", async () => {
    const candidates = pickQuotationDraftCandidates(
      report([
        row({ ticket_id: "WO-036404653" }),
        row({ ticket_id: "WO-036403359", flex_status: "Visit Quote To Customer" }),
      ]),
    );
    mocks.findUnraisedDraftKeys.mockResolvedValue(new Set(["PART:WO036403359"]));
    mocks.query.mockResolvedValue({
      rows: [{ ticket_key: "WO036403359", customer_name: "Dinesh Kumar", customer_city: "Salem" }],
    });

    const raised = await raiseQuotationDrafts(candidates, "6f1f7b1e-0000-4000-8000-000000000001");

    expect(raised).toBe(1);
    // Looked up by the indexed key, for the new one only.
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.query.mock.calls[0]![0])).toContain("w.normalized_ticket_id = t.ticket_key");
    expect(mocks.query.mock.calls[0]![1]).toEqual([["WO036403359"]]);
    expect(mocks.insertQuotationDraft).toHaveBeenCalledTimes(1);
    expect(mocks.insertQuotationDraft.mock.calls[0]![0]).toMatchObject({
      kind: "PART",
      ticketId: "WO-036403359",
      customerName: "Dinesh Kumar",
      customerCity: "Salem",
      reportId: "6f1f7b1e-0000-4000-8000-000000000001",
    });
  });

  it("asks the database every time, so a quotation whose WO was corrected uncovers its work order", async () => {
    const candidates = pickQuotationDraftCandidates(report([row({})]));
    // Covered by a hand-made quotation at first; then that quotation's WO is corrected to
    // another work order, and the same report must now raise this one.
    mocks.findUnraisedDraftKeys
      .mockResolvedValueOnce(new Set())
      .mockResolvedValueOnce(new Set(["VISIT:WO036404653"]));

    expect(await raiseQuotationDrafts(candidates, null)).toBe(0);
    expect(await raiseQuotationDrafts(candidates, null)).toBe(1);

    expect(mocks.findUnraisedDraftKeys).toHaveBeenCalledTimes(2);
  });

  it("asks again after a run that failed part-way", async () => {
    const candidates = pickQuotationDraftCandidates(report([row({})]));
    mocks.findUnraisedDraftKeys.mockResolvedValue(new Set(["VISIT:WO036404653"]));
    mocks.insertQuotationDraft.mockRejectedValueOnce(new Error("connection reset"));

    await expect(raiseQuotationDrafts(candidates, null)).rejects.toThrow("connection reset");
    await raiseQuotationDrafts(candidates, null);

    expect(mocks.findUnraisedDraftKeys).toHaveBeenCalledTimes(2);
    expect(mocks.insertQuotationDraft).toHaveBeenCalledTimes(2);
  });

  it("raises from today's report, in the background", async () => {
    mocks.findUnraisedDraftKeys.mockResolvedValue(new Set(["VISIT:WO036404653"]));

    queueQuotationDraftsFromReport(report([row({})]));
    await settleQuotationDrafts();

    expect(mocks.insertQuotationDraft).toHaveBeenCalledTimes(1);
  });

  it("ignores a past day's report, which the Productivity and RTPL pages reopen", async () => {
    queueQuotationDraftsFromReport(report([row({})], "2026-10-20"));
    await settleQuotationDrafts();

    expect(mocks.findUnraisedDraftKeys).not.toHaveBeenCalled();
    expect(mocks.insertQuotationDraft).not.toHaveBeenCalled();
  });

  it("never lets a failure reach report generation", async () => {
    mocks.findUnraisedDraftKeys.mockRejectedValue(new Error('relation "quotation_drafts" does not exist'));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => queueQuotationDraftsFromReport(report([row({})]))).not.toThrow();
    await settleQuotationDrafts();

    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
