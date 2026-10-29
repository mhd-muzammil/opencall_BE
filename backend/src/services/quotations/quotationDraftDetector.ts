import { istTodayIso } from "@opencall/shared";
import { query } from "../../config/database.js";
import type { GeneratedDailyCallPlanReport } from "../../types/reportGeneration.js";
import type { QuotationKind } from "../../repositories/quotationRepository.js";
import {
  findUnraisedDraftKeys,
  insertQuotationDraft,
  type QuotationDraftInput,
} from "../../repositories/quotationDraftRepository.js";
import { normalizeWoOtcCode } from "../compareService/enrichmentHelpers.js";
import { normalizeFlexStatus } from "../callPlanGenerator/flexStatusUnchangedDays.js";
import { normalizeTicketId } from "../normalization/valueNormalizer.js";

/**
 * Raises the quotations the OpenCall report calls for, to wait in the Quotations section's
 * Waiting Approval box until somebody approves them (the user, 29 Oct 2026):
 *
 *   WO OTC Code 01-Trade + Flex Status "Visit Estimate"           -> a Visit quotation
 *   WO OTC Code 01-Trade + Flex Status "Visit Quote To Customer"  -> a Part quotation
 *
 * Flex Status is FieldEZ's own column (`enriched.flex_status`). The team's RTPL status list
 * has the same words, spelt "Visit Quote to Customer", and must not raise anything: it is
 * typed by people, and a dropdown slip would put a quotation in front of a customer. Real
 * Flex files spell the code "01-Trade" exactly; it is still compared the way the dashboards
 * normalise it, so "01 - Trade" from an older export reads the same.
 *
 * One waiting quotation per kind and work order, ever: one that was approved or removed is
 * never raised again, and neither is one whose work order already has a quotation of the kind.
 */

const TRADE_CODE = "01-TRADE";

/** Keyed by normalizeFlexStatus's output. A Map, so no Flex text can land on a prototype key. */
const KIND_BY_FLEX_STATUS = new Map<string, QuotationKind>([
  ["visit estimate", "VISIT"],
  ["visit quote to customer", "PART"],
]);

/** One work order the report says should wait for approval, as the report has it. */
export interface QuotationDraftCandidate {
  kind: QuotationKind;
  ticketKey: string;
  ticketId: string;
  caseId: string;
  flexStatus: string;
  workLocation: string;
  customerName: string;
  contact: string;
  customerMail: string;
  product: string;
  serialNo: string;
  part: string;
}

const text = (value: unknown): string => String(value ?? "").trim();

/**
 * The work orders in this report that should wait for approval. Synchronous and read from
 * `row.enriched`, which is what FieldEZ sent: the closure overlay that runs after the hook
 * rewrites `row.output["Flex Status"]` in place, and a closed call is not waiting for anything.
 */
export function pickQuotationDraftCandidates(
  report: GeneratedDailyCallPlanReport,
): QuotationDraftCandidate[] {
  const picked: QuotationDraftCandidate[] = [];
  const seen = new Set<string>();
  for (const row of report.rows) {
    // A call that has left the WIP is carried as a closed row with its last Flex Status, so a
    // call closed at Visit Estimate would otherwise wait for approval forever.
    if (row.carryForward.closedSyntheticRow) continue;
    const enriched = row.enriched;
    if (normalizeWoOtcCode(enriched.wo_otc_code) !== TRADE_CODE) continue;
    const kind = KIND_BY_FLEX_STATUS.get(normalizeFlexStatus(enriched.flex_status) ?? "");
    if (!kind) continue;
    const ticketKey = normalizeTicketId(enriched.ticket_id);
    if (!ticketKey) continue;
    // The export is one row per part, so one work order can sit on several rows.
    const key = `${kind}:${ticketKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({
      kind,
      ticketKey,
      ticketId: text(enriched.ticket_id),
      caseId: text(enriched.case_id),
      flexStatus: text(enriched.flex_status),
      workLocation: text(enriched.work_location),
      customerName: text(enriched.customer_name),
      contact: text(enriched.contact),
      customerMail: text(enriched.customer_mail),
      product: text(enriched.product),
      serialNo: text(enriched.product_serial_no),
      part: text(enriched.part),
    });
  }
  return picked;
}

/** The newest Flex WIP row's customer and product fields for one work order. */
interface FlexDetails {
  case_id: string | null;
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

/**
 * The fields the quotation form's "Auto-fill from case" fills, for many work orders in one
 * statement. Looked up by normalized_ticket_id, newest upload first — one probe of
 * idx_flex_wip_ticket_created per work order. The raw "Ticket No" the form's auto-fill matches
 * on has no index, and flex_wip_records is millions of rows that only ever grow.
 */
async function findFlexDetails(ticketKeys: readonly string[]): Promise<Map<string, FlexDetails>> {
  const result = await query<FlexDetails & { ticket_key: string }>(
    `SELECT t.ticket_key,
            f.raw_row->>'Case Id'           AS case_id,
            f.raw_row->>'Customer Name'     AS customer_name,
            f.raw_row->>'Customer Address'  AS customer_address,
            f.raw_row->>'Customer City'     AS customer_city,
            f.raw_row->>'Customer State'    AS customer_state,
            f.raw_row->>'Customer Pincode'  AS customer_pincode,
            f.raw_row->>'Customer Phone No' AS customer_phone,
            f.raw_row->>'Customer Email Id' AS customer_email,
            f.raw_row->>'Product Name'      AS product_name,
            f.raw_row->>'Product Number'    AS product_number,
            f.raw_row->>'Product Serial No' AS product_serial
       FROM unnest($1::text[]) AS t(ticket_key)
       JOIN LATERAL (
              SELECT w.raw_row
                FROM flex_wip_records w
               WHERE w.normalized_ticket_id = t.ticket_key
               ORDER BY w.created_at DESC
               LIMIT 1
            ) f ON TRUE`,
    [ticketKeys],
  );
  return new Map(result.rows.map((row) => [row.ticket_key, row]));
}

/** The first of these that is an email address. The report's column is typed, and says so. */
function firstEmail(...values: unknown[]): string {
  return values.map(text).find((value) => value.includes("@")) ?? "";
}

/** What the waiting quotation is raised with: Flex's customer record, the report's where it has none. */
export function toDraftInput(
  candidate: QuotationDraftCandidate,
  flex: FlexDetails | undefined,
  reportId: string | null,
): QuotationDraftInput {
  return {
    kind: candidate.kind,
    ticketKey: candidate.ticketKey,
    ticketId: candidate.ticketId,
    caseId: candidate.caseId || text(flex?.case_id),
    flexStatus: candidate.flexStatus,
    workLocation: candidate.workLocation,
    customerName: text(flex?.customer_name) || candidate.customerName,
    customerAddress: text(flex?.customer_address),
    customerCity: text(flex?.customer_city),
    customerState: text(flex?.customer_state),
    customerPincode: text(flex?.customer_pincode),
    customerPhone: text(flex?.customer_phone) || candidate.contact,
    // The report's mail column is the one the team corrects by hand, so it wins when it holds
    // an address at all.
    customerEmail: firstEmail(candidate.customerMail, flex?.customer_email),
    productDescription: text(flex?.product_name) || candidate.product,
    modelNo: text(flex?.product_number),
    serialNo: text(flex?.product_serial) || candidate.serialNo,
    part: candidate.part,
    reportId,
  };
}

/**
 * Raise what the report calls for and has not been raised. Returns how many were raised.
 *
 * The database is asked every time, though the report is regenerated on every page load and
 * nearly always lists the same work orders: whether a work order is already covered depends
 * on the quotations too, and correcting a quotation's WO can uncover one without the report
 * changing at all. The question is one statement, and nearly always answers "none".
 */
export async function raiseQuotationDrafts(
  candidates: readonly QuotationDraftCandidate[],
  reportId: string | null,
): Promise<number> {
  if (candidates.length === 0) return 0;
  const unraised = await findUnraisedDraftKeys(candidates);
  const fresh = candidates.filter((c) => unraised.has(`${c.kind}:${c.ticketKey}`));
  let raised = 0;
  if (fresh.length > 0) {
    const details = await findFlexDetails([...new Set(fresh.map((c) => c.ticketKey))]);
    for (const candidate of fresh) {
      const input = toDraftInput(candidate, details.get(candidate.ticketKey), reportId);
      if (await insertQuotationDraft(input)) raised += 1;
    }
    console.log(`[QuotationDrafts] ${raised} quotation(s) now waiting for approval`);
  }
  return raised;
}

/** One run at a time: two page loads a second apart must not race each other's inserts. */
let queue: Promise<unknown> = Promise.resolve();

/** Resolves once every run queued so far has finished. For tests and scripts. */
export function settleQuotationDrafts(): Promise<void> {
  return queue.then(() => undefined);
}

/**
 * Called by report generation with the report it has just built. Picks the work orders now,
 * before the response's closure overlay touches the rows, and raises them in the background:
 * never awaited, never thrown, so a quotation can never slow or fail a report.
 *
 * Only today's report: the Productivity and RTPL pages reopen past days' reports, and a call
 * that was at Visit Estimate last week is not waiting for a quotation now.
 */
export function queueQuotationDraftsFromReport(report: GeneratedDailyCallPlanReport): void {
  try {
    if (report.reportDate !== istTodayIso()) return;
    const candidates = pickQuotationDraftCandidates(report);
    const reportId = report.reportId || null;
    queue = queue
      .then(() => raiseQuotationDrafts(candidates, reportId))
      .catch((error: unknown) => {
        console.error("[QuotationDrafts] raising waiting quotations failed:", error);
      });
  } catch (error) {
    console.error("[QuotationDrafts] reading the report failed:", error);
  }
}
