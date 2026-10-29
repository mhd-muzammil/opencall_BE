import type { PoolClient } from "pg";
import { pool, query } from "../config/database.js";
import {
  insertQuotation,
  type CreateQuotationInput,
  type Quotation,
  type QuotationKind,
} from "./quotationRepository.js";

/**
 * Quotations the OpenCall report raised on its own, waiting for somebody to approve them
 * (migration 072).
 *
 * A waiting quotation has no number and no amount. Approving it is filling in the amount: that
 * raises a real quotation through the same insert createQuotation uses, in the same transaction
 * that marks this row APPROVED. Removing it marks it REMOVED. Either way the row stays, because
 * the row is what stops the next report from raising the same work order again.
 */

export type QuotationDraftStatus = "WAITING" | "APPROVED" | "REMOVED";

export interface QuotationDraft {
  id: string;
  kind: QuotationKind;
  /** The work order as the report shows it, e.g. "WO-036404653". */
  ticketId: string;
  caseId: string;
  /** The Flex Status that raised it, as the report had it. */
  flexStatus: string;
  workLocation: string;
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
  part: string;
  status: QuotationDraftStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string;
  /** The quotation approving it raised. Null while waiting, and for a removed one. */
  quotationId: string | null;
}

/** Everything a waiting quotation is raised with. */
export interface QuotationDraftInput {
  kind: QuotationKind;
  /** The WO as normalizeTicketId writes it: the key the one-per-work-order rule is kept on. */
  ticketKey: string;
  ticketId: string;
  caseId: string;
  flexStatus: string;
  workLocation: string;
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
  part: string;
  reportId: string | null;
}

interface QuotationDraftDbRow {
  id: string;
  kind: string;
  ticket_key: string;
  ticket_id: string;
  case_id: string;
  flex_status: string;
  work_location: string;
  customer_name: string;
  customer_address: string;
  customer_city: string;
  customer_state: string;
  customer_pincode: string;
  customer_phone: string;
  customer_email: string;
  product_description: string;
  model_no: string;
  serial_no: string;
  part: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  quotation_id: string | null;
}

const DRAFT_COLUMNS = `
  id, kind, ticket_key, ticket_id, case_id, flex_status, work_location,
  customer_name, customer_address, customer_city, customer_state, customer_pincode,
  customer_phone, customer_email, product_description, model_no, serial_no, part, status,
  created_at::TEXT AS created_at, decided_at::TEXT AS decided_at, decided_by,
  quotation_id::TEXT AS quotation_id
`;

/**
 * A quotation of this kind already raised for the work order, however it was raised: by hand,
 * before any of this existed, or by approving a waiting one. The WO on a quotation is typed, so
 * it is compared the way normalizeTicketId writes the key — upper-case A-Z and 0-9 only.
 * `kind` and `ticketKey` are SQL expressions of the statement it is used in.
 */
function quotationRaisedFor(kind: string, ticketKey: string): string {
  return `EXISTS (
    SELECT 1 FROM quotations q
     WHERE q.kind = ${kind}
       AND regexp_replace(UPPER(q.order_number), '[^A-Z0-9]', '', 'g') = ${ticketKey}
  )`;
}

function mapDraft(r: QuotationDraftDbRow): QuotationDraft {
  return {
    id: r.id,
    kind: r.kind === "VISIT" ? "VISIT" : "PART",
    ticketId: r.ticket_id,
    caseId: r.case_id,
    flexStatus: r.flex_status,
    workLocation: r.work_location,
    customerName: r.customer_name,
    customerAddress: r.customer_address,
    customerCity: r.customer_city,
    customerState: r.customer_state,
    customerPincode: r.customer_pincode,
    customerPhone: r.customer_phone,
    customerEmail: r.customer_email,
    productDescription: r.product_description,
    modelNo: r.model_no,
    serialNo: r.serial_no,
    part: r.part,
    status: r.status === "APPROVED" || r.status === "REMOVED" ? r.status : "WAITING",
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by ?? "",
    quotationId: r.quotation_id,
  };
}

/**
 * Which of these work orders still need a waiting quotation: no row here for the kind (waiting,
 * approved or removed — a removed one stays removed), and no quotation of the kind raised for
 * the WO. Asked in one statement for the whole report, because the report asks it on every page
 * load and nearly every answer is "none".
 */
export async function findUnraisedDraftKeys(
  keys: readonly { kind: QuotationKind; ticketKey: string }[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const result = await query<{ kind: string; ticket_key: string }>(
    `SELECT c.kind, c.ticket_key
       FROM unnest($1::text[], $2::text[]) AS c(kind, ticket_key)
      WHERE NOT EXISTS (
              SELECT 1 FROM quotation_drafts d
               WHERE d.kind = c.kind AND d.ticket_key = c.ticket_key
            )
        AND NOT ${quotationRaisedFor("c.kind", "c.ticket_key")}`,
    [keys.map((k) => k.kind), keys.map((k) => k.ticketKey)],
  );
  return new Set(result.rows.map((r) => `${r.kind}:${r.ticket_key}`));
}

/**
 * Raise one waiting quotation. Returns false when it already exists or a quotation of the kind
 * now does: the check above and this insert are separate statements, and a person may raise
 * one by hand in between.
 */
export async function insertQuotationDraft(input: QuotationDraftInput): Promise<boolean> {
  const result = await query(
    `INSERT INTO quotation_drafts (
       kind, ticket_key, ticket_id, case_id, flex_status, work_location,
       customer_name, customer_address, customer_city, customer_state, customer_pincode,
       customer_phone, customer_email, product_description, model_no, serial_no, part,
       report_id
     )
     SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text,
            $9::text, $10::text, $11::text, $12::text, $13::text, $14::text, $15::text,
            $16::text, $17::text, $18::uuid
      WHERE NOT ${quotationRaisedFor("$1::text", "$2::text")}
     ON CONFLICT (kind, ticket_key) DO NOTHING
     RETURNING id`,
    [
      input.kind,
      input.ticketKey,
      input.ticketId,
      input.caseId,
      input.flexStatus,
      input.workLocation,
      input.customerName,
      input.customerAddress,
      input.customerCity,
      input.customerState,
      input.customerPincode,
      input.customerPhone,
      input.customerEmail,
      input.productDescription,
      input.modelNo,
      input.serialNo,
      input.part,
      input.reportId,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface ListQuotationDraftsResult {
  items: QuotationDraft[];
  total: number;
}

/** Nobody approves more than this from one screen; the total still counts all of them. */
const LIST_LIMIT = 500;

/**
 * The work orders the Records page shows at a status that raises a quotation, by the page's
 * own rules, so the box and the page's Flex Status filter give one number:
 *
 *   - the report the page opens on: getLatestCompletedReportSession picks the completed
 *     session of the latest report date, then the most recently opened one (Open in History
 *     bumps a session's updated_at), and skips a date more than a day ahead. A report whose
 *     session was deleted is not on the page, so not here either;
 *   - 01-Trade at Flex Status "Visit Estimate" (VISIT) or "Visit Quote To Customer" (PART);
 *   - on a row the page lists: not deleted from the report, open or closed on a same-day
 *     re-upload (isRecordsPageVisibleRow), and not hidden as a former Request to Cancel;
 *   - and still showing that status. The page overlays the closure import's status on a
 *     closed row whatever its date, and on an open row closed on the report's day, and such
 *     a row no longer reads "Visit Quote To Customer". closureDateEnricher finds a row's
 *     closure by its WO id first; a closure no row claimed by WO id then goes, by Case id, to
 *     the first row of that case without one of its own — when it is its case's only one.
 *
 * Until the day's first upload the latest report is yesterday's, so the list does not empty
 * out overnight.
 */
const CURRENT_CALLS = `
  latest AS (
    SELECT r.id, r.report_date
      FROM report_history_sessions s
      JOIN daily_call_plan_reports r ON r.id = s.daily_call_plan_report_id
     WHERE s.status = 'COMPLETED'
       AND r.report_date <= ((NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day')::date
     ORDER BY r.report_date DESC, s.updated_at DESC, s.created_at DESC
     LIMIT 1
  ),
  latest_rows AS (
    SELECT r.id, r.serial_no, r.ticket_id, r.flex_status, r.wo_otc_code, r.change_type,
           r.same_day_closed, r.previous_flex_status,
           UPPER(btrim(r.ticket_id)) AS wo_key,
           UPPER(btrim(COALESCE(r.case_id, ''))) AS case_key
      FROM daily_call_plan_report_rows r
      JOIN latest l ON r.report_id = l.id
     WHERE NOT r.is_excluded
  ),
  wo_claimed AS (
    SELECT DISTINCT c.id
      FROM case_closure_dates c
      JOIN latest_rows lr ON c.wo_id = lr.wo_key
     WHERE c.wo_id <> ''
  ),
  case_claims AS (
    SELECT DISTINCT ON (c.id) c.id AS closure_id, lr.id AS row_id
      FROM case_closure_dates c
      JOIN latest_rows lr ON lr.case_key = c.case_id
     WHERE c.case_id <> ''
       AND NOT EXISTS (
             SELECT 1 FROM case_closure_dates k WHERE k.case_id = c.case_id AND k.id <> c.id
           )
       AND NOT EXISTS (SELECT 1 FROM wo_claimed w WHERE w.id = c.id)
       AND NOT EXISTS (
             SELECT 1 FROM case_closure_dates o WHERE o.wo_id <> '' AND o.wo_id = lr.wo_key
           )
     ORDER BY c.id, lr.serial_no, lr.id
  ),
  current_calls AS (
    SELECT DISTINCT s.kind, regexp_replace(UPPER(lr.ticket_id), '[^A-Z0-9]', '', 'g') AS ticket_key
      FROM latest_rows lr
      CROSS JOIN latest l
      CROSS JOIN LATERAL (
        SELECT CASE lower(regexp_replace(btrim(COALESCE(lr.flex_status, '')), '\\s+', ' ', 'g'))
                 WHEN 'visit estimate' THEN 'VISIT'
                 WHEN 'visit quote to customer' THEN 'PART'
               END AS kind
      ) s
     WHERE s.kind IS NOT NULL
       AND (lr.change_type IS DISTINCT FROM 'CLOSED' OR lr.same_day_closed)
       AND regexp_replace(UPPER(btrim(COALESCE(lr.wo_otc_code, ''))), '\\s*[-–—−]\\s*', '-', 'g') = '01-TRADE'
       AND lower(btrim(COALESCE(lr.previous_flex_status, ''))) <> 'request to cancel'
       AND NOT EXISTS (
             SELECT 1 FROM case_closure_dates c
              WHERE c.wo_id <> '' AND c.wo_id = lr.wo_key
                AND c.closure_status <> ''
                AND (lr.change_type = 'CLOSED' OR c.closed_on = l.report_date)
           )
       AND NOT EXISTS (
             SELECT 1 FROM case_claims cl
               JOIN case_closure_dates c ON c.id = cl.closure_id
              WHERE cl.row_id = lr.id
                AND c.closure_status <> ''
                AND (lr.change_type = 'CLOSED' OR c.closed_on = l.report_date)
           )
  )
`;

/**
 * The quotations waiting for approval, newest first.
 *
 * Only the ones whose work order the Records page shows at the status that raised them (the
 * user, 29 Oct 2026), so the box agrees with the report: a call that has moved on drops off,
 * and comes back if it returns to that status. Nothing is changed by leaving it out — the
 * row stays WAITING, and approving and removing are unaffected.
 *
 * One whose work order has since got a quotation of its kind — raised by hand while this one
 * waited — is left out too: there is nothing left to approve, and approving it would raise a
 * second quotation for the same work.
 */
export async function listQuotationDrafts(input: {
  kind?: QuotationKind;
  search?: string;
}): Promise<ListQuotationDraftsResult> {
  const conditions = [
    `d.status = 'WAITING'`,
    `NOT ${quotationRaisedFor("d.kind", "d.ticket_key")}`,
    `EXISTS (SELECT 1 FROM current_calls cc WHERE cc.kind = d.kind AND cc.ticket_key = d.ticket_key)`,
  ];
  const params: unknown[] = [];
  if (input.kind) {
    params.push(input.kind);
    conditions.push(`d.kind = $${params.length}`);
  }
  const search = (input.search ?? "").trim();
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const i = params.length;
    conditions.push(
      `(lower(d.ticket_id) LIKE $${i} OR lower(d.case_id) LIKE $${i} OR lower(d.customer_name) LIKE $${i})`,
    );
  }
  const where = `WHERE ${conditions.join(" AND ")}`;

  const countResult = await query<{ count: string }>(
    `WITH ${CURRENT_CALLS}
     SELECT COUNT(*)::TEXT AS count FROM quotation_drafts d ${where}`,
    params,
  );
  const rowsResult = await query<QuotationDraftDbRow>(
    `WITH ${CURRENT_CALLS}
     SELECT ${DRAFT_COLUMNS} FROM quotation_drafts d ${where}
     ORDER BY d.created_at DESC, d.ticket_id
     LIMIT ${LIST_LIMIT}`,
    params,
  );
  return {
    items: rowsResult.rows.map(mapDraft),
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export type ApproveQuotationDraftResult =
  | { outcome: "APPROVED"; quotation: Quotation; draft: QuotationDraft }
  | { outcome: "NOT_FOUND" }
  /** Approved or removed already — by someone else, or by a second click. */
  | { outcome: "DECIDED"; draft: QuotationDraft }
  /** The work order got a quotation of this kind while this one waited. */
  | { outcome: "ALREADY_RAISED"; draft: QuotationDraft; quotationNo: string };

/**
 * Approve a waiting quotation: raise the real one from what the person filled in, and mark this
 * one APPROVED, in one transaction.
 *
 * The row is locked first, so two people approving the same one at once raise one quotation
 * and the second is told it is done — and the number is taken only after every check has
 * passed, so a refused approval never uses one up. The kind and the work order are the
 * waiting quotation's own, whatever the form says: a Visit Estimate is approved as a Visit
 * quotation, for its own WO. A WO changed in the form (by hand, or by an auto-fill that found
 * a sibling work order on the same case) would otherwise use this one up on another job and
 * slip past the check below.
 */
export async function approveQuotationDraft(
  id: string,
  input: Omit<CreateQuotationInput, "kind">,
): Promise<ApproveQuotationDraftResult> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<QuotationDraftDbRow>(
      `SELECT ${DRAFT_COLUMNS} FROM quotation_drafts WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = found.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { outcome: "NOT_FOUND" };
    }
    const draft = mapDraft(row);
    if (draft.status !== "WAITING") {
      await client.query("ROLLBACK");
      return { outcome: "DECIDED", draft };
    }

    const raised = await client.query<{ quotation_no: string }>(
      `SELECT q.quotation_no FROM quotations q
        WHERE q.kind = $1
          AND regexp_replace(UPPER(q.order_number), '[^A-Z0-9]', '', 'g') = $2
        ORDER BY q.created_at
        LIMIT 1`,
      [draft.kind, row.ticket_key],
    );
    const existing = raised.rows[0];
    if (existing) {
      await client.query("ROLLBACK");
      return { outcome: "ALREADY_RAISED", draft, quotationNo: existing.quotation_no };
    }

    const quotation = await insertQuotation(client, {
      ...input,
      orderNumber: draft.ticketId,
      kind: draft.kind,
    });
    const approved = await client.query<QuotationDraftDbRow>(
      `UPDATE quotation_drafts
          SET status = 'APPROVED', decided_at = NOW(), decided_by = $2, quotation_id = $3
        WHERE id = $1
        RETURNING ${DRAFT_COLUMNS}`,
      [id, input.createdBy, quotation.id],
    );
    await client.query("COMMIT");
    return { outcome: "APPROVED", quotation, draft: mapDraft(approved.rows[0]!) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type RemoveQuotationDraftResult =
  | { outcome: "REMOVED"; draft: QuotationDraft }
  | { outcome: "NOT_FOUND" }
  | { outcome: "DECIDED"; draft: QuotationDraft };

/** Take a waiting quotation off the list for good. Only a waiting one: an approval stands. */
export async function removeQuotationDraft(
  id: string,
  actor: string,
): Promise<RemoveQuotationDraftResult> {
  const removed = await query<QuotationDraftDbRow>(
    `UPDATE quotation_drafts
        SET status = 'REMOVED', decided_at = NOW(), decided_by = $2
      WHERE id = $1 AND status = 'WAITING'
      RETURNING ${DRAFT_COLUMNS}`,
    [id, actor],
  );
  const row = removed.rows[0];
  if (row) return { outcome: "REMOVED", draft: mapDraft(row) };

  const found = await query<QuotationDraftDbRow>(
    `SELECT ${DRAFT_COLUMNS} FROM quotation_drafts WHERE id = $1`,
    [id],
  );
  const existing = found.rows[0];
  return existing ? { outcome: "DECIDED", draft: mapDraft(existing) } : { outcome: "NOT_FOUND" };
}
