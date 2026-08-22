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
  /**
   * The moment mail starts counting as an answer to this quotation: when it was sent from
   * here, or failing that when it was raised. See the note on the query below.
   */
  watchFrom: string;
  /**
   * What the customer owes, tax included. Carried so a screenshot's figure can be checked
   * against it — the amount is the only thing that tells a part payment from a full one.
   */
  expectedTotal: number;
  /**
   * Where a reply would come FROM. The address it was sent to when it was sent from here,
   * falling back to the one on the sheet — for a quotation handed over another way, that
   * is the only address there is.
   */
  customerEmail: string;
  sentAt: string | null;
  sentTo: string;
  replySeenAt: string | null;
}

/**
 * Quotations still waiting on an answer, sent from here or not.
 *
 * NOT sent from here is the normal case for anything raised before sending existed, and for
 * a quotation handed over on WhatsApp or read out over the phone. Those cannot be re-sent —
 * the customer already has one — but the customer can still write back saying they have
 * paid, and there is no reason the watcher should be blind to that. For them the clock
 * starts at the quotation's own date, which is the earliest moment mail about that work
 * order could be an answer to it.
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
    watch_from: string;
    expected_total: string;
    sent_at: string | null;
    sent_to: string;
    reply_seen_at: string | null;
    customer_email: string;
  }>(
    `SELECT id::TEXT, quotation_no, order_number,
            COALESCE(sent_at, quotation_date::timestamptz)::TEXT AS watch_from,
            (base_amount * (1 + (sgst_percent + cgst_percent) / 100))::TEXT AS expected_total,
            sent_at::TEXT AS sent_at,
            COALESCE(sent_to, '') AS sent_to, reply_seen_at::TEXT AS reply_seen_at,
            LOWER(TRIM(COALESCE(NULLIF(sent_to, ''), customer_email, ''))) AS customer_email
       FROM quotations
      WHERE payment_status = 'PENDING'
        AND TRIM(COALESCE(order_number, '')) <> ''
      ORDER BY COALESCE(sent_at, quotation_date::timestamptz)`,
  );
  return result.rows.map((r) => ({
    id: r.id,
    quotationNo: r.quotation_no,
    orderNumber: r.order_number,
    watchFrom: r.watch_from,
    expectedTotal: Number(r.expected_total) || 0,
    customerEmail: String(r.customer_email ?? ""),
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
  /**
   * A PICTURE is attached, not merely a file.
   *
   * `inbound_emails.has_attachments` cannot answer this: HP and Flex attach an Excel or a
   * PDF to every report thread, and treating those as possible receipts flagged fifty-six
   * quotations in a single sweep, almost none of them about money. A flag that fires on
   * everything is the same as no flag.
   *
   * Inline images are excluded for the same reason — a signature logo is not a receipt.
   */
  hasImage: boolean;
  receivedAt: string;
  isAutoReply: boolean;
}

/** The `hasImage` test, written once because three queries select it. */
const HAS_IMAGE_SQL = `EXISTS (
        SELECT 1 FROM inbound_email_attachments a
         WHERE a.inbound_email_id = inbound_emails.id
           AND NOT a.is_inline
           AND a.mime_type ILIKE 'image/%'
      ) AS has_image`;

/**
 * Mail that arrived about this work order AFTER the quotation went out.
 *
 * The time bound is what keeps this honest: mail predating the quotation cannot be an
 * answer to it, and without the bound an old "payment done" about a previous job on the
 * same work order would settle a quotation raised this morning. For one sent from here the
 * bound is the send; for one that never was, it is the date the quotation was raised.
 *
 * Auto-replies are excluded here rather than filtered later. An out-of-office is not the
 * customer speaking, and letting one count as a reply would silence the follow-up for a
 * customer who has not actually read anything.
 */
export async function listRepliesForQuotation(input: {
  orderNumber: string;
  /** Mail before this cannot be an answer — the send date, or the quotation's own date. */
  watchFrom: string;
}): Promise<QuotationReply[]> {
  const result = await query<{
    id: string;
    from_email: string;
    subject: string;
    body_text: string;
    has_image: boolean;
    received_at: string;
    is_auto_reply: boolean;
  }>(
    `SELECT id::TEXT, from_email, subject, body_text,
            ${HAS_IMAGE_SQL},
            received_at::TEXT AS received_at, is_auto_reply
       FROM inbound_emails
      WHERE UPPER(TRIM(matched_ticket_id)) = UPPER(TRIM($1))
        AND received_at > $2::timestamptz
        AND NOT is_auto_reply
      ORDER BY received_at`,
    [input.orderNumber, input.watchFrom],
  );
  return result.rows.map((r) => ({
    id: r.id,
    fromEmail: String(r.from_email),
    subject: String(r.subject),
    bodyText: String(r.body_text),
    hasImage: Boolean(r.has_image),
    receivedAt: r.received_at,
    isAutoReply: Boolean(r.is_auto_reply),
  }));
}

/**
 * Mail from this customer that the ingest could NOT place against a work order.
 *
 * The fallback for a customer who writes "paid" and quotes nothing. Matching on the sender
 * alone is broader than matching on a WO and correspondingly blunter — it says the right
 * person wrote, not which job they wrote about — so the caller only uses it when that
 * customer has exactly one quotation open. With two, "paid" is genuinely ambiguous and
 * settling either would be a guess.
 *
 * Mail that DID resolve to a work order is excluded: that has already been offered to the
 * quotation for that WO, and letting it in here would settle a different one on the
 * strength of a payment meant for its neighbour.
 */
export async function listUnplacedRepliesFromCustomer(input: {
  fromEmail: string;
  watchFrom: string;
}): Promise<QuotationReply[]> {
  if (!input.fromEmail.trim()) return [];
  const result = await query<{
    id: string;
    from_email: string;
    subject: string;
    body_text: string;
    has_image: boolean;
    received_at: string;
    is_auto_reply: boolean;
  }>(
    `SELECT id::TEXT, from_email, subject, body_text,
            ${HAS_IMAGE_SQL},
            received_at::TEXT AS received_at, is_auto_reply
       FROM inbound_emails
      WHERE LOWER(TRIM(from_email)) = LOWER(TRIM($1))
        AND received_at > $2::timestamptz
        AND NOT is_auto_reply
        AND TRIM(COALESCE(matched_ticket_id, '')) = ''
      ORDER BY received_at`,
    [input.fromEmail, input.watchFrom],
  );
  return result.rows.map((r) => ({
    id: r.id,
    fromEmail: String(r.from_email),
    subject: String(r.subject),
    bodyText: String(r.body_text),
    hasImage: Boolean(r.has_image),
    receivedAt: r.received_at,
    isAutoReply: Boolean(r.is_auto_reply),
  }));
}

export interface ReplyImage {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  content: Buffer;
}

/**
 * The pictures a reply carried, bytes and all.
 *
 * Only real attachments: an inline image is a signature logo or a mail-client decoration,
 * never the receipt someone meant to send. Only images, because the reader can only read
 * those, and smallest first — a receipt is a light file and running that one before a
 * megabyte of photograph gets the answer sooner.
 *
 * Fetched one message at a time and only when the text alone was inconclusive; the bytes
 * are the heaviest thing in this table and there is no reason to hold several at once.
 */
export async function listReplyImages(inboundEmailId: string): Promise<ReplyImage[]> {
  const result = await query<{
    id: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    content: Buffer;
  }>(
    `SELECT id::TEXT, filename, mime_type, size_bytes, content
       FROM inbound_email_attachments
      WHERE inbound_email_id = $1
        AND NOT is_inline
        AND mime_type ILIKE 'image/%'
      ORDER BY size_bytes
      LIMIT 5`,
    [inboundEmailId],
  );
  return result.rows.map((r) => ({
    id: String(r.id),
    filename: String(r.filename),
    mimeType: String(r.mime_type),
    sizeBytes: Number(r.size_bytes) || 0,
    content: r.content,
  }));
}

export interface QuotationSendCheck {
  id: string;
  quotationNo: string;
  orderNumber: string;
  customerEmail: string;
  /** Nothing before this can be the mail that sent it. */
  raisedAt: string;
}

/**
 * Quotations to ask the Sent folder about.
 *
 * A quotation with no send recorded was either never mailed or was mailed before OpenCall
 * could record it, and only the mailbox knows which. That answer costs an IMAP search per
 * quotation per mailbox, so it cannot be asked for all of them on every sweep.
 *
 * Never-asked first, then longest-unasked. A handful per sweep means a hundred quotations
 * settle themselves over an hour rather than the mail server being searched to death every
 * three minutes for ever.
 *
 * ONLY THOSE WITH A CUSTOMER ADDRESS. That address is the whole of the question the verifier
 * asks the Sent folder, so a quotation without one has nothing to be asked. Excluded in the
 * WHERE rather than filtered afterwards: dropped after the LIMIT it would still consume one
 * of the handful the sweep takes, and take it again on every sweep for ever, so a couple of
 * quotations with a blank address would quietly starve the rest of the queue.
 */
export async function listQuotationsNeedingSendCheck(input: {
  limit: number;
  recheckAfterHours: number;
}): Promise<QuotationSendCheck[]> {
  const result = await query<{
    id: string;
    quotation_no: string;
    order_number: string;
    customer_email: string;
    raised_at: string;
  }>(
    `SELECT id::TEXT, quotation_no,
            COALESCE(order_number, '') AS order_number,
            LOWER(TRIM(COALESCE(customer_email, ''))) AS customer_email,
            quotation_date::timestamptz::TEXT AS raised_at
       FROM quotations
      WHERE sent_at IS NULL
        AND payment_status = 'PENDING'
        AND TRIM(COALESCE(customer_email, '')) <> ''
        AND (
          sent_checked_at IS NULL
          OR sent_checked_at < NOW() - make_interval(hours => $2)
        )
      ORDER BY sent_checked_at NULLS FIRST, quotation_date
      LIMIT $1`,
    [input.limit, input.recheckAfterHours],
  );
  return result.rows
    .map((r) => ({
      id: r.id,
      quotationNo: r.quotation_no,
      orderNumber: r.order_number.trim(),
      customerEmail: r.customer_email.trim(),
      raisedAt: r.raised_at,
    }))
    .filter((q) => q.customerEmail);
}

/**
 * Record that the Sent folder was asked, and what it said.
 *
 * `sentAt` present means the mail was found — the quotation did go out, on that date, and
 * Sent now means it with evidence behind it. Absent means asked and not found, which is
 * still worth writing down: it is what stops the same question being asked every sweep.
 *
 * Only rows still carrying no send, so a quotation mailed from OpenCall in the meantime
 * keeps its own real timestamp.
 */
export async function recordQuotationSendCheck(input: {
  id: string;
  sentAt: string | null;
  sentTo: string;
}): Promise<void> {
  if (input.sentAt) {
    await query(
      `UPDATE quotations
          SET sent_at = $2::timestamptz,
              last_sent_at = $2::timestamptz,
              send_count = GREATEST(send_count, 1),
              sent_to = COALESCE(NULLIF(sent_to, ''), NULLIF($3, ''), customer_email, ''),
              sent_by = 'verified from the Sent folder',
              sent_checked_at = NOW()
        WHERE id = $1
          AND sent_at IS NULL`,
      [input.id, input.sentAt, input.sentTo],
    );
    return;
  }
  await query(
    `UPDATE quotations SET sent_checked_at = NOW() WHERE id = $1 AND sent_at IS NULL`,
    [input.id],
  );
}

/**
 * Un-record a reply that turns out not to be one.
 *
 * The watcher can change its mind, and it has to be able to. When the rule for "the
 * customer answered" tightened — mail from the customer's own address, rather than any mail
 * quoting the work order — every quotation flagged under the old rule kept its flag, because
 * a sweep that finds nothing simply moves on. Thirty-nine read as replied when a handful
 * had been.
 *
 * So a quotation with a flag and nothing behind it any more has the flag taken off. The
 * payment status is deliberately NOT touched: a settled quotation is out of this sweep
 * entirely, and a status somebody set by hand is theirs.
 */
export async function clearQuotationReplyState(id: string): Promise<void> {
  await query(
    `UPDATE quotations
        SET reply_seen_at = NULL,
            payment_signal = 'NONE',
            payment_signal_reasons = '',
            payment_evidence_email_id = NULL
      WHERE id = $1
        AND payment_status = 'PENDING'
        AND reply_seen_at IS NOT NULL`,
    [id],
  );
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
