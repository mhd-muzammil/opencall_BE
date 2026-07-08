import { describe, expect, it } from "vitest";
import type { FinalReportManualCarryForwardRow } from "../../repositories/dailyCallPlanReportRepository.js";
import type { EnrichedCallPlanRow, MatchedCallPlanRecord } from "../../types/matching.js";
import type { GeneratedDailyCallPlanRow } from "../../types/reportGeneration.js";
import {
  formatDailyCallPlanRow,
  orderedDailyCallPlanRow,
} from "./dailyCallPlanFormatter.js";
import { ManualFieldCarryForwardService } from "./manualFieldCarryForwardService.js";

function enrichedRow(
  overrides: Partial<EnrichedCallPlanRow> = {},
): EnrichedCallPlanRow {
  return {
    ticket_id: "WO-000123",
    case_id: "CASE-1",
    case_created_time: null,
    wip_aging: "4",
    rtpl_status: "",
    segment: "",
    engineer: null,
    product: "Notebook",
    product_line_name: "Commercial",
    work_location: "ASPS01461",
    flex_status: "Open",
    status_aging: null,
    current_status_aging: null,
    hp_owner_status: null,
    wo_otc_code: "OTC",
    account_name: "Account",
    customer_name: "Customer",
    customer_type: "Consumer",
    location: null,
    contact: null,
    part: null,
    product_serial_no: null,
    wip_aging_category: null,
    tat: null,
    customer_mail: null,
    rca: null,
    remarks: null,
    manual_notes: null,
    match_status: "MATCHED",
    ...overrides,
  };
}

function matchFor(enriched: EnrichedCallPlanRow): MatchedCallPlanRecord {
  return {
    renderways: null,
    flexWip: null,
    callPlan: null,
    flexMatchConfidence: "TICKET_ID",
    callPlanMatchConfidence: "UNMATCHED",
    matchStatus: enriched.match_status,
    enrichedRow: enriched,
    notes: [],
  };
}

function generatedRow(
  overrides: Partial<EnrichedCallPlanRow> = {},
): GeneratedDailyCallPlanRow {
  const enriched = enrichedRow(overrides);

  return {
    id: null,
    serialNo: 1,
    enriched,
    match: matchFor(enriched),
    comparison: null,
    carryForward: {
      carriedForwardFields: [],
      manualFieldsCompleted: false,
      manualFieldsMissing: [],
      changeType: null,
      previousTicketMatched: false,
      closedSyntheticRow: false,
    },
    updatedAt: null,
    updatedBy: null,
    rowEditable: true,
    carryForwardSource: "PREVIOUS_FINAL_REPORT",
    output: orderedDailyCallPlanRow(formatDailyCallPlanRow(1, enriched)),
  };
}

function previousFinalRow(
  overrides: Partial<FinalReportManualCarryForwardRow> = {},
): FinalReportManualCarryForwardRow {
  const row: FinalReportManualCarryForwardRow = {
    serialNo: 1,
    ticketId: "123",
    caseId: "CASE-OLD",
    caseCreatedTime: "2026-03-27T17:41:55.000Z",
    wipAging: "9",
    rtplStatus: "Pending customer",
    eveningRtplStatus: null,
    sourceReportDate: null,
    segment: "Enterprise",
    engineer: "Priya",
    product: "Old product",
    productLineName: "Commercial",
    workLocation: "ASPS01461",
    flexStatus: "Old open",
    hpOwnerStatus: "Actionable",
    woOtcCode: "OLD",
    accountName: "Old account",
    customerName: "Old customer",
    location: "Chennai",
    contact: null,
    part: null,
    wipAgingCategory: null,
    tat: null,
    customerMail: "customer@example.com",
    rca: "Awaiting part",
    remarks: "Call after 4 PM",
    manualNotes: "Escalated locally",
    flexStatusUnchangedDays: null,
    statusAging: "2",
    manualValues: {
      rtpl_status: "Pending customer",
      segment: "Enterprise",
      engineer: "Priya",
      location: "Chennai",
      case_created_time: "2026-03-27T17:41:55.000Z",
      status_aging: "2",
      hp_owner_status: "Actionable",
      customer_mail: "customer@example.com",
      rca: "Awaiting part",
      remarks: "Call after 4 PM",
      manual_notes: "Escalated locally",
    },
    ...overrides,
  };

  return {
    ...row,
    manualValues: {
      rtpl_status: row.rtplStatus,
      segment: row.segment,
      engineer: row.engineer,
      location: row.location,
      case_created_time: row.caseCreatedTime,
      status_aging: row.statusAging,
      hp_owner_status: row.hpOwnerStatus,
      customer_mail: row.customerMail,
      rca: row.rca,
      remarks: row.remarks,
      manual_notes: row.manualNotes,
      ...overrides.manualValues,
    },
  };
}

describe("ManualFieldCarryForwardService", () => {
  const service = new ManualFieldCarryForwardService();

  it("carries only missing manual fields from the previous final report", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [
        generatedRow({
          rtpl_status: "Today status",
          // Segment is freshly derived from the flex file, never carried.
          segment: "Print",
          engineer: null,
          customer_mail: "",
        }),
      ],
      previousFinalRows: [previousFinalRow()],
    });

    const [row] = result.rows;

    expect(row?.enriched.rtpl_status).toBe("Today status");
    expect(row?.enriched.engineer).toBe("Priya");
    expect(row?.enriched.customer_mail).toBe("customer@example.com");
    expect(row?.enriched.product).toBe("Notebook");
    // Segment keeps its freshly-computed value; the previous report's segment
    // ("Enterprise") is NOT carried forward.
    expect(row?.enriched.segment).toBe("Print");
    expect(row?.carryForward.carriedForwardFields).toEqual([
      "engineer",
      "location",
      "case_created_time",
      "status_aging",
      "hp_owner_status",
      "customer_mail",
      "rca",
      "remarks",
      "manual_notes",
    ]);
    expect(result.summary).toEqual({
      totalFieldsCarried: 9,
      rowsAutoCompleted: 1,
      rowsStillManual: 0,
    });
  });

  it("promotes yesterday's Evening to today's Morning and clears Evening (new day)", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [generatedRow({ rtpl_status: "", segment: "Print" })],
      previousFinalRows: [
        previousFinalRow({
          rtplStatus: "Open",
          eveningRtplStatus: "Closed",
          sourceReportDate: "2026-03-27",
        }),
      ],
    });

    const [row] = result.rows;
    // Morning = yesterday's Evening; Evening starts blank for the new day.
    expect(row?.enriched.rtpl_status).toBe("Closed");
    expect(row?.enriched.evening_rtpl_status).toBeNull();
    expect(row?.carryForward.carriedForwardFields).toContain("rtpl_status");
  });

  it("falls back to yesterday's Morning when yesterday's Evening is blank (new day)", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [generatedRow({ rtpl_status: "", segment: "Print" })],
      previousFinalRows: [
        previousFinalRow({
          rtplStatus: "Open",
          eveningRtplStatus: null,
          sourceReportDate: "2026-03-27",
        }),
      ],
    });

    const [row] = result.rows;
    expect(row?.enriched.rtpl_status).toBe("Open");
    expect(row?.enriched.evening_rtpl_status).toBeNull();
  });

  it("keeps the Morning baseline and preserves Evening on a same-day re-upload", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [generatedRow({ rtpl_status: "", segment: "Print" })],
      previousFinalRows: [
        previousFinalRow({
          rtplStatus: "Open",
          eveningRtplStatus: "Closed",
          sourceReportDate: "2026-03-28",
        }),
      ],
    });

    const [row] = result.rows;
    // Same day: Morning unchanged, Evening work preserved.
    expect(row?.enriched.rtpl_status).toBe("Open");
    expect(row?.enriched.evening_rtpl_status).toBe("Closed");
  });

  it("never carries the segment forward, even when the current value is blank", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [generatedRow({ segment: "" })],
      previousFinalRows: [previousFinalRow({ segment: "Print" })],
    });

    const [row] = result.rows;

    // Blank stays blank; the previous report's "Print" is NOT pulled in.
    expect(row?.enriched.segment).toBe("");
    expect(row?.carryForward.carriedForwardFields).not.toContain("segment");
  });

  it("uses the latest saved previous manual value during tomorrow generation", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [generatedRow({ engineer: null })],
      previousFinalRows: [
        previousFinalRow({
          engineer: "Mike",
          manualValues: { engineer: "Mike" },
        }),
      ],
    });

    expect(result.rows[0]?.enriched.engineer).toBe("Mike");
    expect(result.rows[0]?.carryForward.carriedForwardFields).toContain("engineer");
  });

  it("carries a previously manual-entry-required field after it is saved", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [generatedRow({ customer_mail: null })],
      previousFinalRows: [
        previousFinalRow({
          customerMail: "filled@example.com",
          manualValues: { customer_mail: "filled@example.com" },
        }),
      ],
    });

    expect(result.rows[0]?.enriched.customer_mail).toBe("filled@example.com");
    expect(result.rows[0]?.carryForward.carriedForwardFields).toContain("customer_mail");
  });

  it("does not carry placeholders and marks remaining manual fields", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      // Segment is computed from the flex file (never carried), so give it a value.
      currentRows: [generatedRow({ ticket_id: "WO-999", segment: "Print" })],
      previousFinalRows: [
        previousFinalRow({
          ticketId: "999",
          engineer: "Manual Entry Required",
          customerMail: "N/A",
          rca: "--",
          manualValues: {
            engineer: "Manual Entry Required",
            customer_mail: "N/A",
            rca: "--",
          },
        }),
      ],
    });

    const [row] = result.rows;

    expect(row?.enriched.engineer).toBeNull();
    expect(row?.enriched.customer_mail).toBeNull();
    expect(row?.enriched.rca).toBeNull();
    expect(row?.carryForward.manualFieldsMissing).toEqual([
      "engineer",
      "customer_mail",
      "rca",
    ]);
    expect(result.summary.rowsStillManual).toBe(1);
  });

  it("matches only by normalized ticket id and creates closed synthetic rows", () => {
    const result = service.apply({
      currentReportDate: "2026-03-28",
      currentRows: [
        generatedRow({
          ticket_id: "WO-777",
          case_id: "CASE-OLD",
        }),
      ],
      previousFinalRows: [previousFinalRow()],
    });

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.carryForward.changeType).toBe("NEW_WORK_ORDER");
    expect(result.rows[0]?.carryForward.previousTicketMatched).toBe(false);

    const closedRow = result.rows[1];
    expect(closedRow?.enriched.ticket_id).toBe("123");
    expect(closedRow?.carryForward.closedSyntheticRow).toBe(true);
    expect(closedRow?.carryForward.changeType).toBe("CLOSED");
    expect(closedRow?.comparison?.changeType).toBe("CLOSED");
    expect(closedRow?.enriched.engineer).toBe("Priya");
    expect(closedRow?.enriched.work_location).toBe("ASPS01461");
  });
});
