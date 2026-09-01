import type { GeneratedDailyCallPlanReport } from "./reportGeneration.js";

/**
 * The two `enriched` fields the clients actually read.
 *
 * `output` already carries every display column, so the rest of `EnrichedCallPlanRow`
 * is a second copy of data the row is already shipping. These two are the exceptions:
 * neither is an output column, and both drive UI decisions —
 * Customer Type splits Consumer/Commercial, current status aging drives the
 * stale-status banner.
 */
export interface ClientReportRowEnriched {
  customer_type: string | null;
  current_status_aging: number | null;
}

/** One report row as it goes over the wire. Mirrors the frontend's declared row type. */
export interface ClientReportRow {
  id: string | null;
  serialNo: number;
  output: Record<string, unknown>;
  enriched: ClientReportRowEnriched;
  comparison: unknown;
  carryForward: unknown;
  updatedAt: string | null;
  updatedBy: string | null;
  rowEditable: boolean;
  carryForwardSource: "PREVIOUS_FINAL_REPORT";
}

export type ClientReport = Omit<GeneratedDailyCallPlanReport, "rows"> & {
  rows: ClientReportRow[];
};
