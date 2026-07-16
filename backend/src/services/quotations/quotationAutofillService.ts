import { query } from "../../config/database.js";

/**
 * Auto-fill data for a quotation, looked up from the most recent Flex WIP record for a
 * Case ID or WO (Ticket) number. Everything here is a best-effort prefill — the caller
 * can edit any field before saving. Returns null when no matching record is found.
 */

export interface QuotationAutofill {
  caseId: string;
  orderNumber: string;
  customerName: string;
  customerAddress: string;
  customerCity: string;
  customerState: string;
  customerPincode: string;
  customerPhone: string;
  customerEmail: string;
  productDescription: string;
  modelNo: string;
  serialNo: string;
}

interface FlexRow {
  case_id: string | null;
  ticket_no: string | null;
  customer_name: string | null;
  customer_address: string | null;
  customer_city: string | null;
  customer_state: string | null;
  customer_pincode: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  product_name: string | null;
  product_number: string | null;
  product_serial: string | null;
}

export async function autofillQuotation(input: {
  caseId?: string;
  orderNumber?: string;
}): Promise<QuotationAutofill | null> {
  const caseId = (input.caseId ?? "").trim();
  const orderNumber = (input.orderNumber ?? "").trim();
  if (!caseId && !orderNumber) {
    return null;
  }

  // Read straight from the raw Flex WIP record (widest set of customer/product fields).
  const result = await query<FlexRow>(
    `SELECT
        fw.raw_row->>'Case Id'          AS case_id,
        fw.raw_row->>'Ticket No'        AS ticket_no,
        fw.raw_row->>'Customer Name'    AS customer_name,
        fw.raw_row->>'Customer Address' AS customer_address,
        fw.raw_row->>'Customer City'    AS customer_city,
        fw.raw_row->>'Customer State'   AS customer_state,
        fw.raw_row->>'Customer Pincode' AS customer_pincode,
        fw.raw_row->>'Customer Phone No' AS customer_phone,
        fw.raw_row->>'Customer Email Id' AS customer_email,
        fw.raw_row->>'Product Name'     AS product_name,
        fw.raw_row->>'Product Number'   AS product_number,
        fw.raw_row->>'Product Serial No' AS product_serial
     FROM flex_wip_records fw
     WHERE ($1 <> '' AND (fw.case_id = $1 OR fw.normalized_case_id = $1))
        OR ($2 <> '' AND fw.raw_row->>'Ticket No' = $2)
     ORDER BY fw.created_at DESC
     LIMIT 1`,
    [caseId, orderNumber],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const clean = (v: string | null): string => String(v ?? "").trim();
  return {
    caseId: clean(row.case_id) || caseId,
    orderNumber: clean(row.ticket_no) || orderNumber,
    customerName: clean(row.customer_name),
    customerAddress: clean(row.customer_address),
    customerCity: clean(row.customer_city),
    customerState: clean(row.customer_state),
    customerPincode: clean(row.customer_pincode),
    customerPhone: clean(row.customer_phone),
    customerEmail: clean(row.customer_email),
    productDescription: clean(row.product_name),
    modelNo: clean(row.product_number),
    serialNo: clean(row.product_serial),
  };
}
