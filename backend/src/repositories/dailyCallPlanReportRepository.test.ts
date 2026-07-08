import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { EnrichedCallPlanRow, MatchedCallPlanRecord } from "../types/matching.js";
import type { GeneratedDailyCallPlanRow } from "../types/reportGeneration.js";
import {
  findDailyCallPlanReportRowMetadataByReportId,
  findPreviousFinalReportRowsForManualCarryForward,
  insertDailyCallPlanReportRows,
  updateDailyCallPlanReportRowManualFields,
} from "./dailyCallPlanReportRepository.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("../config/database.js", () => ({
  query: mocks.query,
}));

function enrichedRow(): EnrichedCallPlanRow {
  return {
    ticket_id: "WO-123",
    case_id: "CASE-1",
    case_created_time: null,
    wip_aging: "2",
    rtpl_status: "Pending customer",
    segment: "Enterprise",
    engineer: "Priya",
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
    location: "Chennai",
    contact: null,
    part: null,
    product_serial_no: null,
    wip_aging_category: null,
    tat: null,
    customer_mail: "customer@example.com",
    rca: "Awaiting part",
    remarks: null,
    manual_notes: null,
    match_status: "MATCHED",
  };
}

function matchFor(enriched: EnrichedCallPlanRow): MatchedCallPlanRecord {
  return {
    renderways: null,
    flexWip: null,
    callPlan: null,
    flexMatchConfidence: "TICKET_ID",
    callPlanMatchConfidence: "UNMATCHED",
    matchStatus: "MATCHED",
    enrichedRow: enriched,
    notes: ["metadata persistence test"],
  };
}

function generatedRow(): GeneratedDailyCallPlanRow {
  const enriched = enrichedRow();

  return {
    id: null,
    serialNo: 1,
    enriched,
    match: matchFor(enriched),
    comparison: null,
    carryForward: {
      carriedForwardFields: ["engineer", "customer_mail"],
      manualFieldsCompleted: true,
      manualFieldsMissing: [],
      changeType: "CARRIED",
      previousTicketMatched: true,
      closedSyntheticRow: false,
    },
    updatedAt: null,
    updatedBy: null,
    rowEditable: true,
    carryForwardSource: "PREVIOUS_FINAL_REPORT",
    output: {
      "S.no": 1,
      "Ticket ID": "WO-123",
      "Case ID": "CASE-1",
      Segment: "Enterprise",
      "WIP aging": "2",
      Location: "Chennai",
      "RTPL status": "Pending customer",
      "Evening status": "",
      "Current Remarks": "",
      Engineer: "Priya",
      "Flex Status": "Open",
      "Status Aging": "",
      "HP Owner Status": "",
      Part: "",
      "Product Name": "Notebook",
      "Product S.No": "",
      "Product Line Name": "Commercial",
      "Work Location": "ASPS01461",
      "WO OTC CODE": "OTC",
      "Account Name": "Account",
      "Customer Name": "Customer",
      Contact: "",
      "WIP Aging Category": "",
      TAT: "1 day",
      "Customer Mail": "test@example.com",
      RCA: "",
      "Case Created Time": "01-01-2026 00:00:00",
    },
  };
}

describe("insertDailyCallPlanReportRows", () => {
  it("persists carry-forward metadata on final report rows", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ id: "row-1", updated_at: null, updated_by: null }],
    });
    const client = { query } as unknown as PoolClient;

    await insertDailyCallPlanReportRows(client, "report-1", [generatedRow()]);

    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain("carried_forward_fields");
    expect(sql).toContain("manual_fields_completed");
    expect(sql).toContain("manual_fields_missing");
    expect(sql).toContain("product_line_name");
    expect(sql).toContain("work_location");
    expect(sql).toContain("flex_status_unchanged_days");
    expect(values[11]).toBe("Commercial");
    expect(values[12]).toBe("ASPS01461");
    expect(values[33]).toBe(JSON.stringify(["engineer", "customer_mail"]));
    expect(values[34]).toBe(true);
    expect(values[35]).toEqual([]);
    // flex_status_unchanged_days is appended last; null when no comparison insight.
    expect(values[38]).toBeNull();
  });

  it("loads persisted manual fields for regenerated history reports", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "row-1",
          serial_no: 1,
          ticket_id: "WO-123",
          rtpl_status: "Pending customer",
          segment: "Enterprise",
          engineer: "Priya",
          location: "Chennai",
          customer_mail: "customer@example.com",
          rca: "Awaiting part",
          remarks: null,
          manual_notes: null,
          manual_fields_completed: true,
          manual_fields_missing: [],
          updated_at: "2026-05-07T00:00:00.000Z",
          updated_by: "user-1",
        },
      ],
    });
    const client = { query } as unknown as PoolClient;

    const rows = await findDailyCallPlanReportRowMetadataByReportId(client, "report-1");
    const [sql] = query.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain("rtpl_status");
    expect(sql).toContain("manual_fields_missing");
    expect(rows[0]?.rtplStatus).toBe("Pending customer");
    expect(rows[0]?.manualFieldsCompleted).toBe(true);
    expect(rows[0]?.manualFieldsMissing).toEqual([]);
  });

  it("sources carry-forward from the latest report on or before today, excluding the current one", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as PoolClient;

    await findPreviousFinalReportRowsForManualCarryForward(client, {
      reportDate: "2026-07-08",
      regionId: "region-1",
      excludeReportId: "report-current",
    });

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];

    // Same-day reports must be eligible so an afternoon re-upload inherits the
    // morning report's manual work, not just yesterday's final report.
    expect(sql).toContain("effective_report_date <= $1::date");
    // The report being (re)generated must never be its own carry-forward source.
    expect(sql).toContain("report_id::text <> $3::text");
    expect(values).toEqual(["2026-07-08", "region-1", "report-current"]);
  });

  it("passes a null exclusion when generating a brand-new report", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as PoolClient;

    await findPreviousFinalReportRowsForManualCarryForward(client, {
      reportDate: "2026-07-08",
      regionId: "region-1",
    });

    const [, values] = query.mock.calls[0] as [string, unknown[]];
    expect(values[2]).toBeNull();
  });

  it("updates only the addressed report row for persisted manual edits", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: "row-1",
          report_id: "report-1",
          serial_no: 1,
          ticket_id: "WO-123",
          case_id: "CASE-1",
          region_id: "region-1",
          work_location: "ASPS01461",
          case_created_time: null,
          wip_aging: "2",
          status_aging: "4",
          hp_owner_status: "Open",
          engineer: "Mike",
          rtpl_status: "Pending",
          customer_mail: "customer@example.com",
          rca: "Updated RCA",
          remarks: null,
          manual_notes: null,
          location: "Chennai",
          segment: "Enterprise",
          carried_forward_fields: [],
          manual_fields_completed: true,
          manual_fields_missing: [],
          updated_at: "2026-05-07T00:00:00.000Z",
          updated_by: "user-1",
        },
      ],
    });

    await updateDailyCallPlanReportRowManualFields("row-1", {
      engineer: "Mike",
      rtplStatus: "Pending",
      customerMail: "customer@example.com",
      rca: "Updated RCA",
      remarks: null,
      manualNotes: null,
      location: "Chennai",
      segment: "Enterprise",
      statusAging: "4",
      manualFieldsCompleted: true,
      manualFieldsMissing: [],
      updatedBy: "user-1",
    });

    const [sql, values] = mocks.query.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain("WHERE rows.id = $1");
    expect(sql).not.toContain("DELETE");
    expect(sql).not.toContain("daily_call_plan_reports SET");
    expect(values[0]).toBe("row-1");
    expect(values[11]).toBe("4");
  });
});
