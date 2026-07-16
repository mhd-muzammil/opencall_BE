import type { PoolClient } from "pg";
import { pool, query } from "../config/database.js";

export interface Quotation {
  id: string;
  quotationNo: string;
  quotationDate: string;
  caseId: string;
  orderNumber: string;
  customerName: string;
  customerAddress: string;
  customerCity: string;
  customerState: string;
  customerPincode: string;
  customerPhone: string;
  customerEmail: string;
  serviceDescription: string;
  productDescription: string;
  modelNo: string;
  serialNo: string;
  baseAmount: number;
  sgstPercent: number;
  cgstPercent: number;
  createdBy: string;
  createdAt: string;
}

export interface CreateQuotationInput {
  quotationDate: string;
  caseId: string;
  orderNumber: string;
  customerName: string;
  customerAddress: string;
  customerCity: string;
  customerState: string;
  customerPincode: string;
  customerPhone: string;
  customerEmail: string;
  serviceDescription: string;
  productDescription: string;
  modelNo: string;
  serialNo: string;
  baseAmount: number;
  sgstPercent: number;
  cgstPercent: number;
  createdBy: string;
}

interface QuotationDbRow {
  id: string;
  quotation_no: string;
  quotation_date: string;
  case_id: string;
  order_number: string;
  customer_name: string;
  customer_address: string;
  customer_city: string;
  customer_state: string;
  customer_pincode: string;
  customer_phone: string;
  customer_email: string;
  service_description: string;
  product_description: string;
  model_no: string;
  serial_no: string;
  base_amount: string;
  sgst_percent: string;
  cgst_percent: string;
  created_by: string;
  created_at: string;
}

function mapQuotation(r: QuotationDbRow): Quotation {
  return {
    id: r.id,
    quotationNo: r.quotation_no,
    quotationDate: r.quotation_date,
    caseId: r.case_id,
    orderNumber: r.order_number,
    customerName: r.customer_name,
    customerAddress: r.customer_address,
    customerCity: r.customer_city,
    customerState: r.customer_state,
    customerPincode: r.customer_pincode,
    customerPhone: r.customer_phone,
    customerEmail: r.customer_email,
    serviceDescription: r.service_description,
    productDescription: r.product_description,
    modelNo: r.model_no,
    serialNo: r.serial_no,
    baseAmount: Number(r.base_amount),
    sgstPercent: Number(r.sgst_percent),
    cgstPercent: Number(r.cgst_percent),
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

const QUOTATION_COLUMNS = `
  id, quotation_no, quotation_date::TEXT AS quotation_date, case_id, order_number,
  customer_name, customer_address, customer_city, customer_state, customer_pincode,
  customer_phone, customer_email, service_description, product_description, model_no,
  serial_no, base_amount::TEXT AS base_amount, sgst_percent::TEXT AS sgst_percent,
  cgst_percent::TEXT AS cgst_percent, created_by, created_at::TEXT AS created_at
`;

/** Indian financial year label for a date, e.g. 2026-05-04 → "26-27". */
export function financialYearLabel(dateIso: string): string {
  const [y, m] = dateIso.split("-").map((v) => Number(v));
  const year = y ?? new Date().getFullYear();
  const month = m ?? 1;
  // FY starts in April. Before April, it belongs to the previous fin-year.
  const startYear = month >= 4 ? year : year - 1;
  const a = String(startYear).slice(-2);
  const b = String(startYear + 1).slice(-2);
  return `${a}-${b}`;
}

/**
 * Atomically allocates the next quotation number for the date's financial year and
 * inserts the quotation, all in one transaction so numbers never collide or skip.
 */
export async function createQuotation(
  input: CreateQuotationInput,
): Promise<Quotation> {
  const finYear = financialYearLabel(input.quotationDate);
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");

    const seqResult = await client.query<{ last_seq: number }>(
      `INSERT INTO quotation_sequences (fin_year, last_seq)
       VALUES ($1, 1)
       ON CONFLICT (fin_year)
       DO UPDATE SET last_seq = quotation_sequences.last_seq + 1
       RETURNING last_seq`,
      [finYear],
    );
    const seq = seqResult.rows[0]!.last_seq;
    const quotationNo = `RTPL/${finYear}/QEN/${seq}`;

    const result = await client.query<QuotationDbRow>(
      `INSERT INTO quotations (
         quotation_no, quotation_date, case_id, order_number,
         customer_name, customer_address, customer_city, customer_state,
         customer_pincode, customer_phone, customer_email,
         service_description, product_description, model_no, serial_no,
         base_amount, sgst_percent, cgst_percent, created_by
       ) VALUES (
         $1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $17, $18, $19
       )
       RETURNING ${QUOTATION_COLUMNS}`,
      [
        quotationNo,
        input.quotationDate,
        input.caseId,
        input.orderNumber,
        input.customerName,
        input.customerAddress,
        input.customerCity,
        input.customerState,
        input.customerPincode,
        input.customerPhone,
        input.customerEmail,
        input.serviceDescription,
        input.productDescription,
        input.modelNo,
        input.serialNo,
        input.baseAmount,
        input.sgstPercent,
        input.cgstPercent,
        input.createdBy,
      ],
    );

    await client.query("COMMIT");
    return mapQuotation(result.rows[0]!);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface ListQuotationsResult {
  items: Quotation[];
  total: number;
  page: number;
  perPage: number;
  pages: number;
}

export async function listQuotations(input: {
  search?: string;
  page: number;
  perPage: number;
}): Promise<ListQuotationsResult> {
  const page = Math.max(1, input.page);
  const perPage = Math.min(100, Math.max(1, input.perPage));
  const offset = (page - 1) * perPage;

  const conditions: string[] = [];
  const params: unknown[] = [];
  const search = (input.search ?? "").trim();
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const i = params.length;
    conditions.push(
      `(lower(quotation_no) LIKE $${i} OR lower(customer_name) LIKE $${i} OR lower(case_id) LIKE $${i} OR lower(order_number) LIKE $${i})`,
    );
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM quotations ${where}`,
    params,
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  const rowsResult = await query<QuotationDbRow>(
    `SELECT ${QUOTATION_COLUMNS} FROM quotations ${where}
     ORDER BY created_at DESC
     LIMIT ${perPage} OFFSET ${offset}`,
    params,
  );

  return {
    items: rowsResult.rows.map(mapQuotation),
    total,
    page,
    perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
  };
}

export async function findQuotationById(id: string): Promise<Quotation | null> {
  const result = await query<QuotationDbRow>(
    `SELECT ${QUOTATION_COLUMNS} FROM quotations WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapQuotation(row) : null;
}
