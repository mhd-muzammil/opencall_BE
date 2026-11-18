import type { BrandCall } from "../../repositories/brandCallRepository.js";
import type { EnrichedCallPlanRow, MatchedCallPlanRecord } from "../../types/matching.js";

/**
 * Turns open Acer (non-HP) calls into the rows the report generator works with.
 *
 * The generator adds these next to the Flex WIP rows BEFORE the carry-forward, so from
 * there on an Acer call is an ordinary row: yesterday's Evening becomes today's Morning,
 * engineer / remarks / RCA carry forward, a row whose call has closed (closed_at set)
 * is no longer added and the carry-forward closes it, Engineer Productivity counts it
 * and the Payroll sync sends its assignment to the engineer app.
 *
 * Only what the brand's portal says is set here; every manual column (Morning, Evening,
 * engineer, remarks, location once someone edits it) comes from the carry-forward.
 */

/** Extra Records columns for brand calls — the portal's fields Flex has no column for. */
export const BRAND_CALL_OUTPUT_COLUMNS = [
  "Brand",
  "Call Status",
  "Service Type",
  "Warranty Status",
  "Issue Description",
  "Full Address",
  "Pincode",
  "Alt Contact",
] as const;

export function brandCallEnrichedRow(
  call: BrandCall,
  areaNameByPincode: ReadonlyMap<string, string>,
): EnrichedCallPlanRow {
  return {
    ticket_id: call.ticketId,
    case_id: call.caseId,
    // When the call was entered: drives WIP aging, exactly as Flex's create time does.
    case_created_time: call.createdAt,
    wip_aging: null,
    rtpl_status: "",
    evening_rtpl_status: null,
    segment: call.brand,
    engineer: null,
    product: call.model || null,
    product_line_name: call.productCategory || null,
    work_location: call.regionCode,
    // The portal's own status ("Awaiting Onsite Visit") sits where Flex's status does.
    flex_status: call.callStatus || null,
    status_aging: null,
    current_status_aging: null,
    hp_owner_status: call.brand === "ACER" ? "Acer" : call.brand,
    wo_otc_code: call.serviceType || null,
    account_name: call.customerName || null,
    customer_name: call.customerName || null,
    customer_type: null,
    location: areaNameByPincode.get(call.pincode) ?? (call.pincode || null),
    distance_km: null,
    distance_bearing: null,
    distance_is_routed: false,
    contact: call.primaryContact || call.altContact || null,
    part: null,
    product_serial_no: call.serialNumber || null,
    wip_aging_category: null,
    tat: null,
    customer_mail: null,
    rca: null,
    remarks: null,
    manual_notes: null,
    match_status: "MATCHED",
  };
}

export function brandCallMatch(enriched: EnrichedCallPlanRow): MatchedCallPlanRecord {
  return {
    renderways: null,
    flexWip: null,
    callPlan: null,
    flexMatchConfidence: "TICKET_ID",
    callPlanMatchConfidence: "UNMATCHED",
    matchStatus: "MATCHED",
    enrichedRow: enriched,
    notes: [`${enriched.segment} call entered in the CRM`],
  };
}

/** The portal fields the Records page shows on the brand's tab. */
export function brandCallExtraOutput(call: BrandCall): Record<string, string> {
  return {
    Brand: call.brand === "ACER" ? "Acer" : call.brand,
    "Call Status": call.callStatus,
    "Service Type": call.serviceType,
    "Warranty Status": call.warrantyStatus,
    "Issue Description": call.issueDescription,
    "Full Address": call.fullAddress,
    Pincode: call.pincode,
    "Alt Contact": call.altContact,
  };
}
