import { query } from "../config/database.js";

/**
 * Remarks the office types in the Quotations table's Remark column (migration 073): one line
 * against a quotation, or against one waiting for approval.
 *
 * Kept apart from the quotation itself. The sheet, the mail and the count boxes never read a
 * remark, and writing one is not an edit of the sheet: the quotation's updated_at — which a send
 * checks its PDF against — stays where it was.
 */

/** The longest remark the column takes. It is a line in a table, not a letter. */
export const REMARK_MAX_LENGTH = 500;

export interface QuotationRemark {
  /** As typed, trimmed. Empty once somebody clears it. */
  remark: string;
  /** When it was last written, as Postgres writes the moment. */
  updatedAt: string;
  /** Who wrote it last: the actor string quotations.created_by holds. */
  updatedBy: string;
}

export interface QuotationRemarks {
  /**
   * By quotation id. A quotation raised for a waiting one — by approving it, or by hand for its
   * WO — shows that one's remark until it is given a remark of its own, so nothing typed while
   * it waited is lost when it leaves the waiting list.
   */
  quotations: Record<string, QuotationRemark>;
  /** By waiting quotation id. */
  drafts: Record<string, QuotationRemark>;
}

interface RemarkDbRow {
  quotation_id: string | null;
  draft_id: string | null;
  /**
   * For a waiting one's remark: the quotation raised for it — the one approving it raised, or,
   * when its work order was quoted some other way, the first quotation of its kind for that WO.
   */
  raised_into: string | null;
  remark: string;
  updated_at: string;
  updated_by: string;
}

const REMARK_COLUMNS = `
  quotation_id::TEXT AS quotation_id, draft_id::TEXT AS draft_id,
  remark, updated_at::TEXT AS updated_at, updated_by
`;

function toRemark(row: RemarkDbRow): QuotationRemark {
  return { remark: row.remark, updatedAt: row.updated_at, updatedBy: row.updated_by };
}

/**
 * Every remark, for the page to put beside its rows by id. A small table, read whole.
 *
 * A waiting one's remark also goes on the quotation raised for it, because the waiting row leaves
 * the list the moment that quotation exists. Approving it names that quotation (quotation_id); a
 * quotation raised by hand for its WO does not, so that one is found the way the waiting list
 * finds it (quotationRaisedFor: same kind, same WO as normalizeTicketId writes it) — the first
 * raised, as the approval's own "already has" check picks.
 */
export async function listQuotationRemarks(): Promise<QuotationRemarks> {
  const result = await query<RemarkDbRow>(
    `SELECT r.quotation_id::TEXT AS quotation_id, r.draft_id::TEXT AS draft_id,
            COALESCE(d.quotation_id, (
              SELECT q.id FROM quotations q
               WHERE q.kind = d.kind
                 AND regexp_replace(UPPER(q.order_number), '[^A-Z0-9]', '', 'g') = d.ticket_key
               ORDER BY q.created_at
               LIMIT 1
            ))::TEXT AS raised_into,
            r.remark, r.updated_at::TEXT AS updated_at, r.updated_by
       FROM quotation_remarks r
       LEFT JOIN quotation_drafts d ON d.id = r.draft_id`,
  );

  const quotations = new Map<string, QuotationRemark>();
  const drafts = new Map<string, QuotationRemark>();
  // A quotation's own remark first, so the one it carried from waiting can never replace it —
  // not even when the own one has been cleared to nothing.
  for (const row of result.rows) {
    if (row.quotation_id) quotations.set(row.quotation_id, toRemark(row));
  }
  for (const row of result.rows) {
    if (!row.draft_id) continue;
    drafts.set(row.draft_id, toRemark(row));
    if (row.raised_into && !quotations.has(row.raised_into)) {
      quotations.set(row.raised_into, toRemark(row));
    }
  }
  return { quotations: Object.fromEntries(quotations), drafts: Object.fromEntries(drafts) };
}

/**
 * Write a quotation's remark, replacing any it had. Null when there is no such quotation, so the
 * caller can answer 404 rather than store a remark against nothing.
 */
export async function setQuotationRemark(input: {
  quotationId: string;
  remark: string;
  actor: string;
}): Promise<QuotationRemark | null> {
  const result = await query<RemarkDbRow>(
    `INSERT INTO quotation_remarks (quotation_id, remark, updated_by)
     SELECT q.id, $2::text, $3::text FROM quotations q WHERE q.id = $1::uuid
     ON CONFLICT (quotation_id) DO UPDATE
        SET remark = EXCLUDED.remark, updated_at = NOW(), updated_by = EXCLUDED.updated_by
     RETURNING ${REMARK_COLUMNS}`,
    [input.quotationId, input.remark, input.actor],
  );
  const row = result.rows[0];
  return row ? toRemark(row) : null;
}

export type SetQuotationDraftRemarkResult =
  | { outcome: "SAVED"; remark: QuotationRemark }
  | { outcome: "NOT_FOUND" }
  /** Approved or removed already: its row has left the waiting list. */
  | { outcome: "DECIDED"; draft: { ticketId: string; status: string } };

/**
 * Write a waiting quotation's remark, replacing any it had. Only while it waits: once approved,
 * its remark is the quotation's to change, and a removed one is off the list for good.
 */
export async function setQuotationDraftRemark(input: {
  draftId: string;
  remark: string;
  actor: string;
}): Promise<SetQuotationDraftRemarkResult> {
  const result = await query<RemarkDbRow>(
    `INSERT INTO quotation_remarks (draft_id, remark, updated_by)
     SELECT d.id, $2::text, $3::text FROM quotation_drafts d
      WHERE d.id = $1::uuid AND d.status = 'WAITING'
     ON CONFLICT (draft_id) DO UPDATE
        SET remark = EXCLUDED.remark, updated_at = NOW(), updated_by = EXCLUDED.updated_by
     RETURNING ${REMARK_COLUMNS}`,
    [input.draftId, input.remark, input.actor],
  );
  const row = result.rows[0];
  if (row) return { outcome: "SAVED", remark: toRemark(row) };

  const found = await query<{ ticket_id: string; status: string }>(
    `SELECT ticket_id, status FROM quotation_drafts WHERE id = $1::uuid`,
    [input.draftId],
  );
  const draft = found.rows[0];
  return draft
    ? { outcome: "DECIDED", draft: { ticketId: draft.ticket_id, status: draft.status } }
    : { outcome: "NOT_FOUND" };
}
