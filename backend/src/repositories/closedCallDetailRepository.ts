import { query } from "../config/database.js";

/**
 * Per-call detail for the Closed Calls drill-down.
 *
 * Read-only, and deliberately a NEW file: the Closed Calls detail feature must not
 * edit an existing repository, service or calculation — same rule the Engineer Target
 * feature beside it followed. Nothing here writes, and no existing query is touched.
 *
 * This repository only ADDS the descriptive columns (Segment / Product Name /
 * Work Location / WO OTC CODE) for rows the caller has already decided are closed.
 * It never decides what "closed" means — that stays with the shared
 * `computeEngineerProductivity`, so a drill-down list can never disagree with the
 * count shown beside it.
 */

/** One closed call's descriptive fields, as stored on the day's report row. */
export interface ClosedCallDetailRow {
  serialNo: number;
  ticketId: string;
  caseId: string;
  engineer: string;
  segment: string;
  /** "Product Name" in the Daily Call Plan Report columns. */
  productName: string;
  workLocation: string;
  /** "WO OTC CODE" in the Daily Call Plan Report columns. */
  woOtcCode: string;
}

/**
 * Descriptive fields for the given ticket IDs on one report.
 *
 * `ticketIds` comes from `EngineerProductivityEntry.closedTickets`, so the result is
 * exactly the set of calls that produced that engineer's closed count. Excluded rows
 * are filtered the same way `findProductivityRowsByReportId` filters them, so a row
 * dropped from the count can never reappear in the detail.
 */
export async function findClosedCallDetailsByReportId(
  reportId: string,
  ticketIds: string[],
): Promise<ClosedCallDetailRow[]> {
  if (ticketIds.length === 0) {
    return [];
  }

  // A row whose "Ticket ID" column is blank is identified by the shared calculation
  // as its serial number instead (`String(row.output["Ticket ID"]).trim() ||
  // String(row.serialNo)`). Matching only on ticket_id therefore drops exactly those
  // calls — counted, but absent from the list that is supposed to explain the count.
  // Only purely numeric ids are tried against serial_no, so a real ticket reference
  // can never be pulled in by a coincidental number.
  const serialIds = ticketIds.filter((id) => /^\d+$/.test(id));

  const result = await query<{
    serial_no: number;
    ticket_id: string | null;
    case_id: string | null;
    engineer: string | null;
    segment: string | null;
    product: string | null;
    work_location: string | null;
    wo_otc_code: string | null;
  }>(
    `
      SELECT
        serial_no,
        ticket_id,
        case_id,
        engineer,
        segment,
        product,
        work_location,
        wo_otc_code
      FROM daily_call_plan_report_rows
      WHERE report_id = $1
        AND NOT is_excluded
        AND (
          ticket_id = ANY($2::text[])
          OR (
            coalesce(ticket_id, '') = ''
            AND serial_no::text = ANY($3::text[])
          )
        )
      ORDER BY serial_no ASC, id ASC
    `,
    [reportId, ticketIds, serialIds],
  );

  return result.rows.map((row) => ({
    serialNo: row.serial_no,
    ticketId: row.ticket_id ?? "",
    caseId: row.case_id ?? "",
    engineer: row.engineer ?? "",
    segment: row.segment ?? "",
    productName: row.product ?? "",
    workLocation: row.work_location ?? "",
    woOtcCode: row.wo_otc_code ?? "",
  }));
}
