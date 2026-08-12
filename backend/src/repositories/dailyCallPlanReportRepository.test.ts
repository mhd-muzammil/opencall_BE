import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { EnrichedCallPlanRow, MatchedCallPlanRecord } from "../types/matching.js";
import type { GeneratedDailyCallPlanRow } from "../types/reportGeneration.js";
import {
  MANUAL_CARRY_FORWARD_FIELDS,
  OPTIONAL_MANUAL_CARRY_FORWARD_FIELDS,
} from "../types/reportGeneration.js";
import {
  adoptReportRowEveningStatusFromAuthority,
  findDailyCallPlanReportRowMetadataByReportId,
  findPreviousFinalReportRowsForManualCarryForward,
  findSameDayUserSetEveningRows,
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
    distance_km: null,
    distance_bearing: null,
    distance_is_routed: false,
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
      sameDayClosedRow: false,
      regionScopeRetainedRow: false,
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
      Distance: "",
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
    expect(sql).toContain("customer_type");
    expect(sql).toContain("same_day_closed");
    // Positions shifted +1 by the new evening_rtpl_status column (inserted right after
    // rtpl_status), then +2 by customer_type / product_serial_no (after customer_name).
    expect(values[12]).toBe("Commercial");
    expect(values[13]).toBe("ASPS01461");
    expect(values[19]).toBe("Consumer");
    expect(values[36]).toBe(JSON.stringify(["engineer", "customer_mail"]));
    expect(values[37]).toBe(true);
    expect(values[38]).toEqual([]);
    // flex_status_unchanged_days is null when there is no comparison insight.
    expect(values[41]).toBeNull();
    // same_day_closed is appended last.
    expect(values[42]).toBe(false);
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

  it("exposes every declared carry-forward field in manualValues", async () => {
    // Regression (prod 2026-07-21): case_created_time and hp_owner_status were
    // absent from manualValues, so carry-forward silently skipped them. Nobody
    // noticed until a Flex upload arrived with no Create Time and 177 rows lost
    // their WIP aging — the previous day's date was there to inherit, but the
    // carry-forward could not see it.
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          serial_no: 1,
          ticket_id: "WO-034696026",
          case_id: "CASE-1",
          case_created_time: "2026-06-06T10:08:12.522Z",
          wip_aging: "36",
          status_aging: "2",
          rtpl_status: "SSC Pending",
          evening_rtpl_status: null,
          segment: "PC",
          engineer: "sriram",
          hp_owner_status: "Actionable",
          location: "Ayapakkam",
          customer_mail: null,
          rca: null,
          remarks: null,
          manual_notes: null,
          same_day_closed: false,
        },
      ],
    });
    const client = { query } as unknown as PoolClient;

    const rows = await findPreviousFinalReportRowsForManualCarryForward(client, {
      reportDate: "2026-07-21",
    });

    expect(rows[0]?.manualValues.case_created_time).toBe("2026-06-06T10:08:12.522Z");
    expect(rows[0]?.manualValues.hp_owner_status).toBe("Actionable");
    for (const field of [
      ...MANUAL_CARRY_FORWARD_FIELDS,
      ...OPTIONAL_MANUAL_CARRY_FORWARD_FIELDS,
    ]) {
      expect(rows[0]?.manualValues).toHaveProperty(field);
    }
  });

  it("sources carry-forward from the latest report on or before today, excluding the current one", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as PoolClient;

    await findPreviousFinalReportRowsForManualCarryForward(client, {
      reportDate: "2026-07-08",
      excludeReportId: "report-current",
    });

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];

    // Same-day reports must be eligible so an afternoon re-upload inherits the
    // morning report's manual work, not just yesterday's final report.
    expect(sql).toContain("effective_report_date <= $1::date");
    // The report being (re)generated must never be its own carry-forward source.
    expect(sql).toContain("report_id::text <> $2::text");
    expect(values).toEqual(["2026-07-08", "report-current"]);
  });

  it("selects the source across regions and by upload order, immune to reopens", async () => {
    // Regression (prod 2026-07-24): the source query filtered sessions by the
    // requester's region_id and ordered same-day ties by updated_at. A
    // different admin's next upload (different region selection) could not see
    // today's earlier report, so carry-forward fell back to a PRIOR day and
    // the day-boundary rule wiped every Evening entered earlier today; and a
    // mere reopen (which bumps updated_at) could promote a stale same-day
    // report over the one holding the day's Evening work.
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as PoolClient;

    await findPreviousFinalReportRowsForManualCarryForward(client, {
      reportDate: "2026-07-24",
      excludeReportId: "report-current",
    });

    const [sql] = query.mock.calls[0] as [string, unknown[]];

    expect(sql).not.toContain("region_id IS NOT DISTINCT FROM");
    expect(sql).toContain(
      "ORDER BY effective_report_date DESC, created_at DESC, id DESC",
    );
    expect(sql).not.toContain("updated_at DESC");
  });

  it("passes a null exclusion when generating a brand-new report", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as PoolClient;

    await findPreviousFinalReportRowsForManualCarryForward(client, {
      reportDate: "2026-07-08",
    });

    const [, values] = query.mock.calls[0] as [string, unknown[]];
    expect(values[1]).toBeNull();
  });

  it("exposes the source row's own Evening edit time for the same-day Evening rules", async () => {
    // Regression (prod 2026-07-30): this used to expose rows.updated_at, a
    // WHOLE-ROW timestamp every manual edit stamps. A source row whose Evening
    // was never touched then out-voted the same-day authority the moment
    // anyone edited its Engineer, and the Evening was wiped. It must NOT fall
    // back to updated_at: a NULL here means "the Evening was never user-set on
    // this row", which is exactly what must not win.
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as PoolClient;

    await findPreviousFinalReportRowsForManualCarryForward(client, {
      reportDate: "2026-07-29",
    });

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      "rows.evening_rtpl_status_updated_at::TEXT AS evening_updated_at",
    );
    expect(sql).not.toContain("AS row_updated_at");
  });

  it("exposes the persisted row's Evening edit time, never the whole-row one", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as PoolClient;

    await findDailyCallPlanReportRowMetadataByReportId(client, "report-1");

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      "evening_rtpl_status_updated_at::TEXT AS evening_updated_at",
    );
    expect(sql).not.toContain(
      "COALESCE(evening_rtpl_status_updated_at, updated_at)",
    );
  });

  it("finds only user-touched, non-blank Evenings for the given date, newest first", async () => {
    // The same-day Evening authority: it must consider EVERY report of the
    // date (not one LIMIT-1 source), only rows a user actually edited
    // (updated_at stamped — generation never stamps it), skip soft-deleted
    // rows, and order newest-edit-first so the first row per ticket wins.
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          ticket_id: "WO-123",
          evening_rtpl_status: "Attended",
          evening_updated_at: "2026-07-29 17:30:00+05:30",
        },
      ],
    });
    const client = { query } as unknown as PoolClient;

    const rows = await findSameDayUserSetEveningRows(client, {
      reportDate: "2026-07-29",
    });

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("reports.report_date = $1::date");
    expect(sql).toContain("rows.updated_at IS NOT NULL");
    expect(sql).toContain("NOT rows.is_excluded");
    expect(sql).toContain(
      "NULLIF(TRIM(COALESCE(rows.evening_rtpl_status, '')), '') IS NOT NULL",
    );
    // Every row here already holds a non-blank Evening, so falling back to the
    // whole-row timestamp is a safe estimate of when it was set — and it keeps
    // the authority working for rows written before migration 040.
    expect(sql).toContain(
      "COALESCE(rows.evening_rtpl_status_updated_at, rows.updated_at)",
    );
    expect(values).toEqual(["2026-07-29"]);
    expect(rows).toEqual([
      {
        ticketId: "WO-123",
        eveningRtplStatus: "Attended",
        eveningUpdatedAt: "2026-07-29 17:30:00+05:30",
      },
    ]);
  });

  it("adopts the authority's Evening guarded by edit time, not by blankness", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const client = { query } as unknown as PoolClient;

    await adoptReportRowEveningStatusFromAuthority(client, {
      rowId: "row-1",
      eveningRtplStatus: "Case-Closed",
      authorityEveningUpdatedAt: "2026-08-07 17:30:00+05:30",
    });

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];

    // The guard MUST NOT be "only if blank". That is what left a row holding a
    // STALE non-blank Evening untouched, so a newer value saved on another of
    // today's reports never reached it — the "it comes back to the same old
    // status" complaint that survived four rounds of vanishing-Evening fixes.
    expect(sql).not.toContain(
      "NULLIF(TRIM(COALESCE(evening_rtpl_status, '')), '') IS NULL",
    );
    expect(sql).toContain("evening_rtpl_status_updated_at IS NULL");
    expect(sql).toContain("evening_rtpl_status_updated_at < $3");

    // Still guarded in-SQL so a concurrent save always wins.
    expect(sql).toContain("evening_rtpl_status IS DISTINCT FROM $2");

    // A system copy of another report's user edit — must NOT stamp either
    // timestamp, or it would outrank the original in the authority ordering.
    expect(sql).not.toContain("SET evening_rtpl_status = $2,");
    expect(sql).not.toContain("updated_at = NOW()");
    expect(values).toEqual(["row-1", "Case-Closed", "2026-08-07 17:30:00+05:30"]);
  });

  it("still writes when the authority has no Evening timestamp", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const client = { query } as unknown as PoolClient;

    await adoptReportRowEveningStatusFromAuthority(client, {
      rowId: "row-1",
      eveningRtplStatus: "Attended",
      authorityEveningUpdatedAt: null,
    });

    const [, values] = query.mock.calls[0] as [string, unknown[]];
    // Null is passed through; the SQL then only adopts onto rows that were
    // never Evening-edited, so a real user edit here is never clobbered.
    expect(values).toEqual(["row-1", "Attended", null]);
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
    // No Evening in this PATCH, so the Evening's own timestamp is left alone
    // while updated_at is still stamped as it always was.
    expect(sql).toContain("updated_at = NOW()");
    expect(values[21]).toBe(false);
  });

  it("stamps the Evening's own timestamp only when the edit carries an Evening", async () => {
    mocks.query.mockResolvedValue({ rows: [] });

    await updateDailyCallPlanReportRowManualFields("row-1", {
      // A CLEAR still counts as an Evening edit — that is the whole point: it
      // is what lets a deliberate blank out-vote the same-day authority.
      eveningRtplStatus: null,
      eveningRtplStatusEdited: true,
      manualFieldsCompleted: true,
      manualFieldsMissing: [],
      updatedBy: "user-1",
    });

    // mocks.query is shared across this file's tests and never reset, so read
    // the call this test just made rather than the first one recorded.
    const [sql, values] = mocks.query.mock.calls.at(-1) as [string, unknown[]];

    expect(sql).toContain("evening_rtpl_status_updated_at = CASE");
    expect(sql).toContain("WHEN $22::bool THEN NOW()");
    expect(sql).toContain("ELSE rows.evening_rtpl_status_updated_at");
    expect(values[21]).toBe(true);
  });
});
