import { query } from "../config/database.js";

/**
 * The join between a quotation and the reply it drew.
 *
 * Kept out of quotationRepository because it reads across two features — quotations and the
 * inbound mailbox — and neither of those repositories should grow a dependency on the other
 * to serve one sweep.
 *
 * The link is the WORK ORDER, not the mail thread. Threading headers are the tidier answer
 * and the unreliable one: customers reply from a different address, forward the quotation
 * to accounts, or start a fresh mail quoting the WO in the subject, and any of those breaks
 * In-Reply-To while leaving the work order intact. The ingest already resolves a WO for
 * every message it can place, so matching on that catches the replies threading would miss.
 */

export interface AwaitingQuotation {
  id: string;
  quotationNo: string;
  orderNumber: string;
  sentAt: string;
  sentTo: string;
  replySeenAt: string | null;
}

/**
 * Quotations that have gone out and are still waiting.
 *
 * Only PENDING ones: a quotation already settled — paid, or declined — has nothing left for
 * a reply to change, and re-reading its mail every sweep would mean a later "thanks" could
 * un-decide a decision someone made deliberately.
 */
export async function listQuotationsAwaitingReply(): Promise<AwaitingQuotation[]> {
  const result = await query<{
    id: string;
    quotation_no: string;
    order_number: string;
    sent_at: string;
    sent_to: string;
    reply_seen_at: string | null;
  }>(
    `SELECT id::TEXT, quotation_no, order_number, sent_at::TEXT AS sent_at,
            COALESCE(sent_to, '') AS sent_to, reply_seen_at::TEXT AS reply_seen_at
       FROM quotations
      WHERE sent_at IS NOT NULL
        AND payment_status = 'PENDING'
        AND TRIM(COALESCE(order_number, '')) <> ''
      ORDER BY sent_at`,
  );
  return result.rows.map((r) => ({
    id: r.id,
    quotationNo: r.quotation_no,
    orderNumber: r.order_number,
    sentAt: r.sent_at,
    sentTo: r.sent_to,
    replySeenAt: r.reply_seen_at,
  }));
}

export interface QuotationReply {
  id: string;
  fromEmail: string;
  subject: string;
  bodyText: string;
  hasAttachments: boolean;
  receivedAt: string;
  isAutoReply: boolean;
}

/**
 * Mail that arrived about this work order AFTER the quotation went out.
 *
 * The `sent_at` bound is what keeps this honest: mail predating the quotation cannot be a
 * reply to it, and without the bound an old "payment done" about a previous job on the same
 * work order would settle a quotation raised this morning.
 *
 * Auto-replies are excluded here rather than filtered later. An out-of-office is not the
 * customer speaking, and letting one count as a reply would silence the follow-up for a
 * customer who has not actually read anything.
 */
export async function listRepliesForQuotation(input: {
  orderNumber: string;
  sentAt: string;
}): Promise<QuotationReply[]> {
  const result = await query<{
    id: string;
    from_email: string;
    subject: string;
    body_text: string;
    has_attachments: boolean;
    received_at: string;
    is_auto_reply: boolean;
  }>(
    `SELECT id::TEXT, from_email, subject, body_text, has_attachments,
            received_at::TEXT AS received_at, is_auto_reply
       FROM inbound_emails
      WHERE UPPER(TRIM(matched_ticket_id)) = UPPER(TRIM($1))
        AND received_at > $2::timestamptz
        AND NOT is_auto_reply
      ORDER BY received_at`,
    [input.orderNumber, input.sentAt],
  );
  return result.rows.map((r) => ({
    id: r.id,
    fromEmail: String(r.from_email),
    subject: String(r.subject),
    bodyText: String(r.body_text),
    hasAttachments: Boolean(r.has_attachments),
    receivedAt: r.received_at,
    isAutoReply: Boolean(r.is_auto_reply),
  }));
}

/**
 * Record what the sweep made of a quotation's replies.
 *
 * `markPaid` is the only branch that changes the quotation's status, and it is written as a
 * conditional UPDATE rather than checked first and written after: the sweep and a person
 * clicking "Paid" or "Declined" can run at the same moment, and the WHERE clause is what
 * stops the sweep overwriting a decision that landed a fraction of a second earlier.
 */
export async function recordQuotationReplyState(input: {
  id: string;
  replySeenAt: string;
  signal: "NONE" | "WEAK" | "STRONG";
  reasons: string;
  evidenceEmailId: string | null;
  markPaid: boolean;
}): Promise<boolean> {
  const result = await query<{ id: string }>(
    `UPDATE quotations
        SET reply_seen_at = $2::timestamptz,
            payment_signal = $3,
            payment_signal_reasons = $4,
            payment_evidence_email_id = $5::uuid,
            payment_status = CASE WHEN $6 THEN 'PAID' ELSE payment_status END,
            payment_source = CASE WHEN $6 THEN 'AUTO' ELSE payment_source END,
            paid_at = CASE WHEN $6 THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
            paid_by = CASE WHEN $6 THEN 'auto: customer reply' ELSE paid_by END
      WHERE id = $1
        AND payment_status = 'PENDING'
      RETURNING id::TEXT`,
    [
      input.id,
      input.replySeenAt,
      input.signal,
      input.reasons,
      input.evidenceEmailId,
      input.markPaid,
    ],
  );
  return result.rows.length > 0;
}
