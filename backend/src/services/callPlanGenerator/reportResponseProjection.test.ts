import { describe, expect, it } from "vitest";
import type { GeneratedDailyCallPlanRow } from "../../types/reportGeneration.js";
import { toClientReport, toClientReportRow } from "./reportResponseProjection.js";

function generatedRow(): GeneratedDailyCallPlanRow {
  const enriched = {
    ticket_id: "WO-123",
    case_id: "CASE-1",
    customer_type: "Consumer",
    current_status_aging: 4,
    work_location: "ASPS01461",
    remarks: "carried over from yesterday",
  } as unknown as GeneratedDailyCallPlanRow["enriched"];

  return {
    id: "row-1",
    serialNo: 1,
    output: { "Ticket ID": "WO-123", "Customer Address": "12 Anna Salai, Chennai" },
    enriched,
    match: {
      renderways: null,
      callPlan: null,
      flexWip: {
        // The whole source Excel row — the bulk of what used to go over the wire.
        rawRow: { "Work Order": "WO-123", "Customer Address": "12 Anna Salai, Chennai" },
      },
      // The generator assigns the very same object as `enriched`; JSON has no notion of
      // a shared reference and used to write it out a second time.
      enrichedRow: enriched,
      notes: ["matched on case id"],
    },
    comparison: null,
    carryForward: { carriedForwardFields: ["engineer"] },
    updatedAt: null,
    updatedBy: null,
    rowEditable: true,
    carryForwardSource: "PREVIOUS_FINAL_REPORT",
  } as unknown as GeneratedDailyCallPlanRow;
}

describe("toClientReportRow", () => {
  it("drops the generator's working state from the payload", () => {
    const projected = toClientReportRow(generatedRow()) as unknown as Record<
      string,
      unknown
    >;

    expect(projected).not.toHaveProperty("match");
    // Nothing may reintroduce the raw source rows by any route.
    expect(JSON.stringify(projected)).not.toContain("rawRow");
    expect(JSON.stringify(projected)).not.toContain("matched on case id");
  });

  it("keeps exactly the two enriched fields the clients read", () => {
    const projected = toClientReportRow(generatedRow());

    expect(projected.enriched).toEqual({
      customer_type: "Consumer",
      current_status_aging: 4,
    });
    // `output` is where every display value lives; `enriched` must not become a second
    // copy of it again just because a field was added to the working row.
    expect(Object.keys(projected.enriched)).toHaveLength(2);
  });

  it("passes the client contract through untouched", () => {
    const row = generatedRow();
    const projected = toClientReportRow(row);

    expect(projected.id).toBe("row-1");
    expect(projected.serialNo).toBe(1);
    expect(projected.output).toBe(row.output);
    expect(projected.carryForward).toBe(row.carryForward);
    expect(projected.rowEditable).toBe(true);
    expect(projected.carryForwardSource).toBe("PREVIOUS_FINAL_REPORT");
  });
});

describe("toClientReport", () => {
  it("projects every row and leaves the report's own fields alone", () => {
    const report = {
      reportId: "report-1",
      totalRows: 2,
      rows: [generatedRow(), generatedRow()],
    };

    const projected = toClientReport(report);

    expect(projected.reportId).toBe("report-1");
    expect(projected.totalRows).toBe(2);
    expect(projected.rows).toHaveLength(2);
    expect(projected.rows.every((row) => !("match" in row))).toBe(true);
  });
});
