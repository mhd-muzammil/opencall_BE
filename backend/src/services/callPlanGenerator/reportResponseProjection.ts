import type { GeneratedDailyCallPlanRow } from "../../types/reportGeneration.js";
import type {
  ClientReport,
  ClientReportRow,
} from "../../types/reportResponse.js";

/**
 * Drops the generator's internal working state from a report before it is serialized.
 *
 * `GeneratedDailyCallPlanRow` is a WORKING object: the matching engine, carry-forward,
 * region scoping and the region breakdown all read `row.match` and the full `row.enriched`
 * while the report is being built. None of that is part of the client contract, and until
 * this projection existed all of it was JSON.stringify'd to the browser on every page load
 * — report generation runs on each one.
 *
 * What was being sent per row, on top of what the client reads:
 *
 *   match.flexWip.rawRow    every column of the source Excel row, verbatim
 *   match.renderways        the same again for the Renderways file
 *   match.callPlan          and again for the call plan
 *   match.enrichedRow       a second copy of `enriched` (the generator assigns the very
 *                           same object, but JSON has no notion of a shared reference and
 *                           writes it out twice)
 *   enriched.*              ~45 fields of which the clients read exactly two; `output`
 *                           already carries the display values
 *
 * Measured against a real Flex WIP export (626 rows x 49 columns, ~1.8 KB of JSON per raw
 * row) that is roughly three copies of every row's source data in a payload the client
 * reads one of. On a full production report it is tens of megabytes to serialize, gzip,
 * transfer and parse before the dashboard can render.
 *
 * Deliberately applied at the SERIALIZATION boundary, not earlier: `filterReportForRegions`,
 * the special-access and vendor scoping filters, `syncPartsCallCountsFromReport` and
 * `computeRegionBreakdown` all still need the full row, and they run before this.
 */
export function toClientReportRow(row: GeneratedDailyCallPlanRow): ClientReportRow {
  return {
    id: row.id,
    serialNo: row.serialNo,
    output: row.output,
    // Not `row.enriched` itself: spreading it would put the whole working row back on
    // the wire the moment a field is added to it.
    enriched: {
      customer_type: row.enriched.customer_type,
      current_status_aging: row.enriched.current_status_aging,
    },
    comparison: row.comparison,
    carryForward: row.carryForward,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    rowEditable: row.rowEditable,
    carryForwardSource: row.carryForwardSource,
  };
}

/** The whole report, with every row reduced to the client contract. */
export function toClientReport<
  T extends { rows: GeneratedDailyCallPlanRow[] },
>(report: T): Omit<T, "rows"> & Pick<ClientReport, "rows"> {
  return {
    ...report,
    rows: report.rows.map(toClientReportRow),
  };
}
