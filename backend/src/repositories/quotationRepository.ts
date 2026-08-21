import type { PoolClient } from "pg";
import { pool, query } from "../config/database.js";

/**
 * One priced row on a quotation.
 *
 * The parent's `serviceDescription` / `productDescription` / `modelNo` / `serialNo` mirror
 * the FIRST of these and `baseAmount` mirrors their SUM, so everything that read a
 * quotation before line items existed still reads a correct one.
 */
export interface QuotationLineItem {
  serviceDescription: string;
  productDescription: string;
  modelNo: string;
  serialNo: string;
  baseAmount: number;
}

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
  /** Null until someone corrects the sheet — an unedited quotation has no edit to report. */
  updatedAt: string | null;
  updatedBy: string;
  /** Null until the quotation has been mailed from here. Not "sent and undated". */
  sentAt: string | null;
  sentTo: string;
  sentBy: string;
  /** Every send including follow-ups, so "chased three times" is visible. */
  sendCount: number;
  lastSentAt: string | null;
  /** 'PENDING' | 'PAID' | 'DECLINED' */
  paymentStatus: string;
  paidAt: string | null;
  paidBy: string;
  paymentNote: string;
  /** 'MANUAL' | 'AUTO' — a person's call, or one a rule inferred from a reply. */
  paymentSource: string;
  /** The reply that earned the status, so the badge can say why and the undo is informed. */
  paymentEvidenceEmailId: string | null;
  /** Any reply at all, payment-shaped or not. Null while the customer has said nothing. */
  replySeenAt: string | null;
  /** 'NONE' | 'WEAK' | 'STRONG' — WEAK still needs a person to look. */
  paymentSignal: string;
  paymentSignalReasons: string;
  /** Every priced row, in entry order. Never empty — a pre-053 quotation has exactly one. */
  lineItems: QuotationLineItem[];
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
  /**
   * The priced rows. A caller that still sends the flat single-item fields is normalised
   * into a one-element list by the controller, so this is always the source of truth here.
   */
  lineItems: QuotationLineItem[];
  sgstPercent: number;
  cgstPercent: number;
  createdBy: string;
}

/**
 * Everything a quotation can become. Deliberately the same shape as creating one — the
 * form is the same form — minus the two things an edit must never touch: the running
 * number and who issued it.
 */
export type UpdateQuotationInput = Omit<CreateQuotationInput, "createdBy"> & {
  updatedBy: string;
};

interface QuotationDbRow {
  id: string;
  updated_at: string | null;
  updated_by: string | null;
  sent_at: string | null;
  sent_to: string | null;
  sent_by: string | null;
  send_count: number | string | null;
  last_sent_at: string | null;
  payment_status: string | null;
  paid_at: string | null;
  paid_by: string | null;
  payment_note: string | null;
  payment_source: string | null;
  payment_evidence_email_id: string | null;
  reply_seen_at: string | null;
  payment_signal: string | null;
  payment_signal_reasons: string | null;
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

interface LineItemDbRow {
  quotation_id: string;
  service_description: string;
  product_description: string;
  model_no: string;
  serial_no: string;
  base_amount: string;
}

function mapLineItem(r: LineItemDbRow): QuotationLineItem {
  return {
    serviceDescription: r.service_description,
    productDescription: r.product_description,
    modelNo: r.model_no,
    serialNo: r.serial_no,
    baseAmount: Number(r.base_amount),
  };
}

/**
 * Load the items for a page of quotations in ONE query rather than per row.
 *
 * A quotation with no rows in the child table can only be one written by a build older
 * than 053 that has not been backfilled; it falls back to the parent columns so the sheet
 * still prints rather than coming out blank.
 */
async function attachLineItems(quotations: Quotation[]): Promise<Quotation[]> {
  if (quotations.length === 0) return quotations;

  const result = await query<LineItemDbRow>(
    `SELECT quotation_id::TEXT AS quotation_id, service_description, product_description,
            model_no, serial_no, base_amount::TEXT AS base_amount
       FROM quotation_line_items
      WHERE quotation_id = ANY($1::uuid[])
      ORDER BY quotation_id, position, created_at`,
    [quotations.map((q) => q.id)],
  );

  const byQuotation = new Map<string, QuotationLineItem[]>();
  for (const row of result.rows) {
    const list = byQuotation.get(row.quotation_id) ?? [];
    list.push(mapLineItem(row));
    byQuotation.set(row.quotation_id, list);
  }

  for (const quotation of quotations) {
    const items = byQuotation.get(quotation.id);
    quotation.lineItems =
      items && items.length > 0
        ? items
        : [
            {
              serviceDescription: quotation.serviceDescription,
              productDescription: quotation.productDescription,
              modelNo: quotation.modelNo,
              serialNo: quotation.serialNo,
              baseAmount: quotation.baseAmount,
            },
          ];
  }
  return quotations;
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
    updatedAt: r.updated_at,
    updatedBy: r.updated_by ?? "",
    sentAt: r.sent_at,
    sentTo: r.sent_to ?? "",
    sentBy: r.sent_by ?? "",
    sendCount: Number(r.send_count) || 0,
    lastSentAt: r.last_sent_at,
    paymentStatus: r.payment_status ?? "PENDING",
    paidAt: r.paid_at,
    paidBy: r.paid_by ?? "",
    paymentNote: r.payment_note ?? "",
    paymentSource: r.payment_source ?? "MANUAL",
    paymentEvidenceEmailId: r.payment_evidence_email_id,
    replySeenAt: r.reply_seen_at,
    paymentSignal: r.payment_signal ?? "NONE",
    paymentSignalReasons: r.payment_signal_reasons ?? "",
    // Filled by attachLineItems; never left empty by the time a caller sees it.
    lineItems: [],
  };
}

const QUOTATION_COLUMNS = `
  id, quotation_no, quotation_date::TEXT AS quotation_date, case_id, order_number,
  customer_name, customer_address, customer_city, customer_state, customer_pincode,
  customer_phone, customer_email, service_description, product_description, model_no,
  serial_no, base_amount::TEXT AS base_amount, sgst_percent::TEXT AS sgst_percent,
  cgst_percent::TEXT AS cgst_percent, created_by, created_at::TEXT AS created_at,
  updated_at::TEXT AS updated_at, updated_by,
  sent_at::TEXT AS sent_at, sent_to, sent_by,
  send_count, last_sent_at::TEXT AS last_sent_at,
  payment_status, paid_at::TEXT AS paid_at, paid_by, payment_note,
  payment_source, payment_evidence_email_id::TEXT AS payment_evidence_email_id,
  reply_seen_at::TEXT AS reply_seen_at, payment_signal, payment_signal_reasons
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

    // The parent row mirrors the items: `base_amount` is the SUBTOTAL, so the list view's
    // Total column keeps working without being touched, and the four description columns
    // carry the first item so a reader that predates line items still sees a real row.
    const items = input.lineItems;
    const first = items[0];
    const subtotal = items.reduce((sum, item) => sum + item.baseAmount, 0);

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
        first?.serviceDescription ?? "",
        first?.productDescription ?? "",
        first?.modelNo ?? "",
        first?.serialNo ?? "",
        subtotal,
        input.sgstPercent,
        input.cgstPercent,
        input.createdBy,
      ],
    );

    const quotationId = result.rows[0]!.id;
    for (const [index, item] of items.entries()) {
      await client.query(
        `INSERT INTO quotation_line_items (
           quotation_id, position, service_description, product_description,
           model_no, serial_no, base_amount
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          quotationId,
          index,
          item.serviceDescription,
          item.productDescription,
          item.modelNo,
          item.serialNo,
          item.baseAmount,
        ],
      );
    }

    await client.query("COMMIT");
    // Straight from the input: the rows were just written in this transaction, so a
    // re-read would only be a round trip to learn what we already know.
    return { ...mapQuotation(result.rows[0]!), lineItems: items };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Correct an existing quotation in place.
 *
 * THE RUNNING NUMBER DOES NOT MOVE. `quotation_no` is what the customer has on the sheet
 * already, and `quotation_sequences` is never touched here — correcting a typo must not
 * burn a number or issue a second one for the same work. `created_by` and `created_at`
 * stay put for the same reason: they record who raised it, which an edit does not change.
 *
 * Line items are replaced wholesale rather than diffed. The form hands back the list it
 * has, rows can be added, removed and reordered in one edit, and matching them up to
 * decide which are "the same row" would be guesswork over a set that has no stable id in
 * the UI. Delete-then-insert inside the transaction is exact, and `position` comes out
 * matching the order on screen.
 *
 * Returns null when the id does not exist, so the caller can answer 404 rather than
 * silently succeed at nothing.
 */
export async function updateQuotation(
  id: string,
  input: UpdateQuotationInput,
): Promise<Quotation | null> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");

    // Same mirroring as createQuotation: the parent keeps the SUBTOTAL and the first
    // item's descriptions, so the list view and any reader predating line items still see
    // a whole row.
    const items = input.lineItems;
    const first = items[0];
    const subtotal = items.reduce((sum, item) => sum + item.baseAmount, 0);

    const result = await client.query<QuotationDbRow>(
      `UPDATE quotations SET
         quotation_date = $2::date,
         case_id = $3,
         order_number = $4,
         customer_name = $5,
         customer_address = $6,
         customer_city = $7,
         customer_state = $8,
         customer_pincode = $9,
         customer_phone = $10,
         customer_email = $11,
         service_description = $12,
         product_description = $13,
         model_no = $14,
         serial_no = $15,
         base_amount = $16,
         sgst_percent = $17,
         cgst_percent = $18,
         updated_by = $19,
         updated_at = NOW()
       WHERE id = $1
       RETURNING ${QUOTATION_COLUMNS}`,
      [
        id,
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
        first?.serviceDescription ?? "",
        first?.productDescription ?? "",
        first?.modelNo ?? "",
        first?.serialNo ?? "",
        subtotal,
        input.sgstPercent,
        input.cgstPercent,
        input.updatedBy,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(`DELETE FROM quotation_line_items WHERE quotation_id = $1`, [id]);
    for (const [index, item] of items.entries()) {
      await client.query(
        `INSERT INTO quotation_line_items (
           quotation_id, position, service_description, product_description,
           model_no, serial_no, base_amount
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          index,
          item.serviceDescription,
          item.productDescription,
          item.modelNo,
          item.serialNo,
          item.baseAmount,
        ],
      );
    }

    await client.query("COMMIT");
    return { ...mapQuotation(row), lineItems: items };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Record that a quotation went out.
 *
 * Called only after the mail has actually left, so a failed send leaves the quotation
 * reading "not sent" rather than claiming a delivery that never happened.
 *
 * `sent_at` is stamped once and `last_sent_at` every time: the first tells you how long
 * the customer has had it, which is what "quiet for a week" is measured from, and a
 * follow-up must not reset that clock or a chased quotation would look brand new.
 */
export async function markQuotationSent(input: {
  id: string;
  sentTo: string;
  sentBy: string;
}): Promise<Quotation | null> {
  const result = await query<QuotationDbRow>(
    `UPDATE quotations
        SET sent_at = COALESCE(sent_at, NOW()),
            last_sent_at = NOW(),
            send_count = send_count + 1,
            sent_to = $2,
            sent_by = $3
      WHERE id = $1
      RETURNING ${QUOTATION_COLUMNS}`,
    [input.id, input.sentTo, input.sentBy],
  );
  const row = result.rows[0];
  if (!row) return null;
  const [withItems] = await attachLineItems([mapQuotation(row)]);
  return withItems ?? null;
}

/**
 * Record what the customer did about it.
 *
 * Deliberately a human's decision rather than something inferred from a reply. A customer
 * answers with a screenshot of a transfer, a half-payment, a question, or a refusal, and
 * reading intent out of that automatically would eventually mark an unpaid quotation paid
 * — which is the one error that costs money. The reply is surfaced; the call is made here.
 *
 * Moving away from PAID clears the payment stamp, so a status set by mistake does not leave
 * a paid-on date behind claiming otherwise.
 */
export async function setQuotationPayment(input: {
  id: string;
  status: "PENDING" | "PAID" | "DECLINED";
  note: string;
  actor: string;
}): Promise<Quotation | null> {
  const paid = input.status === "PAID";
  const result = await query<QuotationDbRow>(
    `UPDATE quotations
        SET payment_status = $2,
            payment_note = $3,
            paid_at = CASE WHEN $2 = 'PAID' THEN COALESCE(paid_at, NOW()) ELSE NULL END,
            paid_by = CASE WHEN $2 = 'PAID' THEN $4 ELSE NULL END,
            -- Set by hand from here on. Someone has looked, so the badge must stop
            -- claiming a machine decided it and the watcher must not re-decide.
            payment_source = 'MANUAL' 
      WHERE id = $1
      RETURNING ${QUOTATION_COLUMNS}`,
    [input.id, input.status, input.note, paid ? input.actor : null],
  );
  const row = result.rows[0];
  if (!row) return null;
  const [withItems] = await attachLineItems([mapQuotation(row)]);
  return withItems ?? null;
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
    items: await attachLineItems(rowsResult.rows.map(mapQuotation)),
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
  if (!row) return null;
  const [quotation] = await attachLineItems([mapQuotation(row)]);
  return quotation ?? null;
}
