import { query } from "../config/database.js";

/**
 * Storage for the customer email ingest (Stage 1, read-only).
 *
 * Self-contained: no existing repository is modified. The only cross-feature read is a
 * lookup of report rows to match a message to a call, and that is a plain SELECT.
 */

export interface RegionMailbox {
  id: string;
  regionCode: string;
  email: string;
  isActive: boolean;
  /** Only mail received at or after this is ever ingested — the back-catalogue guard. */
  ingestFrom: string;
  lastPolledAt: string | null;
  lastError: string;
}

export async function listActiveMailboxes(): Promise<RegionMailbox[]> {
  const result = await query<{
    id: string;
    region_code: string;
    email: string;
    is_active: boolean;
    ingest_from: string;
    last_polled_at: string | null;
    last_error: string;
  }>(
    `SELECT id::TEXT, region_code, email, is_active,
            ingest_from::TEXT, last_polled_at::TEXT, last_error
       FROM region_mailboxes
      WHERE is_active
      ORDER BY region_code, email`,
  );
  return result.rows.map((r) => ({
    id: r.id,
    regionCode: r.region_code,
    email: r.email,
    isActive: r.is_active,
    ingestFrom: r.ingest_from,
    lastPolledAt: r.last_polled_at,
    lastError: r.last_error,
  }));
}

/**
 * Register a mailbox if it is not already known. `ingest_from` is stamped NOW on first
 * registration and never moved afterwards, so re-running this can't drag the watermark
 * backwards and pull in the history.
 */
export async function ensureMailbox(input: {
  regionCode: string;
  email: string;
}): Promise<RegionMailbox> {
  await query(
    `INSERT INTO region_mailboxes (region_code, email)
     VALUES ($1, $2)
     ON CONFLICT (lower(email)) DO UPDATE
       SET region_code = EXCLUDED.region_code,
           is_active = TRUE,
           updated_at = NOW()`,
    [input.regionCode, input.email],
  );
  const all = await listActiveMailboxes();
  return all.find((m) => m.email.toLowerCase() === input.email.toLowerCase())!;
}

export async function markMailboxPolled(
  email: string,
  errorText: string,
): Promise<void> {
  await query(
    `UPDATE region_mailboxes
        SET last_polled_at = NOW(), last_error = $2, updated_at = NOW()
      WHERE lower(email) = lower($1)`,
    [email, errorText],
  );
}

/**
 * The IMAP UIDs already stored for one mailbox.
 *
 * The watermark never moves, so every sweep's SEARCH re-offers the whole range since
 * `ingest_from` — hundreds of messages once a mailbox falls a few days behind. The
 * message_id conflict below still guards the INSERT, but it only fires after the message
 * has been downloaded and parsed, which is the expensive half. Subtracting what is already
 * held lets a bounded batch move forward through the backlog instead of re-reading the
 * same oldest mail on every pass.
 */
export async function listStoredImapUids(mailboxEmail: string): Promise<Set<number>> {
  const result = await query<{ imap_uid: string }>(
    `SELECT imap_uid
       FROM inbound_emails
      WHERE lower(mailbox_email) = lower($1)
        AND imap_uid IS NOT NULL`,
    [mailboxEmail],
  );
  const uids = new Set<number>();
  for (const row of result.rows) {
    const uid = Number(row.imap_uid);
    if (Number.isFinite(uid)) uids.add(uid);
  }
  return uids;
}

export interface InboundEmailInput {
  mailboxEmail: string;
  regionCode: string;
  messageId: string;
  imapUid: number | null;
  fromEmail: string;
  fromName: string;
  subject: string;
  bodyPreview: string;
  bodyText: string;
  /** The sender's own HTML, sanitised at ingest. Empty when the mail was plain text only. */
  bodyHtml: string;
  hasAttachments: boolean;
  receivedAt: string;
  matchedTicketId: string;
  matchedCaseId: string;
  matchMethod: string;
  matchConfidence: string;
  isAutoReply: boolean;
  escalationLevel: string;
  escalationReasons: string;
}

/**
 * Insert a message; a re-poll of the same message is a no-op.
 *
 * Returns the new row's id, or null when the message was already stored. The id is what
 * the attachment rows hang off, so a duplicate poll cannot double-store the bytes either.
 */
export async function insertInboundEmail(
  input: InboundEmailInput,
): Promise<string | null> {
  const result = await query<{ id: string }>(
    `INSERT INTO inbound_emails (
       mailbox_email, region_code, message_id, imap_uid,
       from_email, from_name, subject, body_preview, body_text, body_html,
       has_attachments, received_at,
       matched_ticket_id, matched_case_id, match_method, match_confidence, is_auto_reply,
       escalation_level, escalation_reasons
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (mailbox_email, message_id) DO NOTHING
     RETURNING id::TEXT`,
    [
      input.mailboxEmail,
      input.regionCode,
      input.messageId,
      input.imapUid,
      input.fromEmail,
      input.fromName,
      input.subject,
      input.bodyPreview,
      input.bodyText,
      input.bodyHtml,
      input.hasAttachments,
      input.receivedAt,
      input.matchedTicketId,
      input.matchedCaseId,
      input.matchMethod,
      input.matchConfidence,
      input.isAutoReply,
      input.escalationLevel,
      input.escalationReasons,
    ],
  );
  return result.rows[0]?.id ?? null;
}

export interface InboundAttachmentInput {
  contentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isInline: boolean;
  content: Buffer;
}

/**
 * Store a message's files. Called only with the id of a row that was just inserted, so
 * there is no duplicate path; a failure here leaves the message itself readable.
 */
export async function insertInboundEmailAttachments(
  inboundEmailId: string,
  attachments: readonly InboundAttachmentInput[],
): Promise<number> {
  let stored = 0;
  for (const attachment of attachments) {
    await query(
      `INSERT INTO inbound_email_attachments
         (inbound_email_id, content_id, filename, mime_type, size_bytes, is_inline, content)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        inboundEmailId,
        attachment.contentId,
        attachment.filename,
        attachment.mimeType,
        attachment.sizeBytes,
        attachment.isInline,
        attachment.content,
      ],
    );
    stored += 1;
  }
  return stored;
}

export interface InboundAttachmentRow {
  id: string;
  contentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isInline: boolean;
}

/** Metadata only — the bytes are fetched one at a time by the download route. */
export async function findAttachmentsForEmail(
  inboundEmailId: string,
): Promise<InboundAttachmentRow[]> {
  const result = await query<{
    id: string;
    content_id: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    is_inline: boolean;
  }>(
    `SELECT id::TEXT, content_id, filename, mime_type, size_bytes, is_inline
       FROM inbound_email_attachments
      WHERE inbound_email_id = $1
      ORDER BY is_inline, created_at`,
    [inboundEmailId],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    contentId: String(row.content_id),
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes) || 0,
    isInline: Boolean(row.is_inline),
  }));
}

/**
 * One attachment's bytes, scoped by its parent message.
 *
 * The message id is part of the WHERE on purpose: the download route already checked the
 * caller may see that message, and this makes an attachment id from another region useless
 * even if one were guessed.
 */
export async function findAttachmentContent(
  inboundEmailId: string,
  attachmentId: string,
): Promise<{ filename: string; mimeType: string; content: Buffer } | null> {
  const result = await query<{ filename: string; mime_type: string; content: Buffer }>(
    `SELECT filename, mime_type, content
       FROM inbound_email_attachments
      WHERE inbound_email_id = $1 AND id = $2`,
    [inboundEmailId, attachmentId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    content: Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content ?? []),
  };
}

export interface InboundEmailRow extends InboundEmailInput {
  id: string;
  status: string;
  createdAt: string;
}

/** One cell of the count matrix: how much mail sits at this status in this region. */
export interface InboundEmailCount {
  status: string;
  regionCode: string;
  total: number;
  escalations: number;
}

/**
 * How much mail is actually held, grouped by status and region.
 *
 * The reader used to count the rows it had loaded, so every tally in the header was really
 * "how many of the newest page are these" — the totals sat at the page size and stopped
 * moving, which reads as a cap on what is kept rather than on what is shown. These counts
 * are of the whole table, so a page of 200 can honestly say there are 743.
 *
 * Returned as a matrix rather than pre-summed: the status tabs want it summed across
 * regions, the region chips want one status' slice, and the escalation filter wants the
 * flagged subset of whichever of those is showing. One GROUP BY answers all three.
 */
export async function countInboundEmails(
  regionCodes: string[] | null,
): Promise<InboundEmailCount[]> {
  const values: unknown[] = [];
  let where = "";
  if (regionCodes) {
    values.push(regionCodes);
    where = `WHERE UPPER(region_code) = ANY($${values.length}::TEXT[])`;
  }

  const result = await query<{
    status: string;
    region_code: string;
    total: string;
    escalations: string;
  }>(
    `SELECT status,
            UPPER(region_code) AS region_code,
            COUNT(*)::TEXT AS total,
            COUNT(*) FILTER (WHERE escalation_level <> 'NONE')::TEXT AS escalations
       FROM inbound_emails
       ${where}
      GROUP BY status, UPPER(region_code)`,
    values,
  );

  return result.rows.map((r) => ({
    status: String(r.status),
    regionCode: String(r.region_code),
    total: Number(r.total) || 0,
    escalations: Number(r.escalations) || 0,
  }));
}

/** Mail held against one work order, for the marker on the report row. */
export interface InboundEmailWoSummary {
  ticketId: string;
  total: number;
  escalations: number;
  /** Newest message for this WO, so the row can say how recently the customer wrote. */
  lastReceivedAt: string;
}

/**
 * Which work orders have mail against them, and how much.
 *
 * Answers the report table's question — "has this customer written about this case?" — in
 * one query rather than one per row. A report is nine hundred rows and the answer for most
 * of them is "no", so it has to be a single GROUP BY the client turns into a lookup, not a
 * join onto the report or a request per ticket.
 *
 * Only matched mail counts. `matched_ticket_id` is set when a WO number in the subject or
 * body was found in the report, so a blank one is mail we could not place and has no row
 * to mark.
 */
export async function countInboundEmailsByTicket(
  regionCodes: string[] | null,
): Promise<InboundEmailWoSummary[]> {
  const values: unknown[] = [];
  let regionClause = "";
  if (regionCodes) {
    values.push(regionCodes);
    regionClause = ` AND UPPER(region_code) = ANY($${values.length}::TEXT[])`;
  }

  const result = await query<{
    ticket_id: string;
    total: string;
    escalations: string;
    last_received_at: string;
  }>(
    `SELECT UPPER(TRIM(matched_ticket_id)) AS ticket_id,
            COUNT(*)::TEXT AS total,
            COUNT(*) FILTER (WHERE escalation_level <> 'NONE')::TEXT AS escalations,
            MAX(received_at)::TEXT AS last_received_at
       FROM inbound_emails
      WHERE TRIM(COALESCE(matched_ticket_id, '')) <> ''${regionClause}
      GROUP BY UPPER(TRIM(matched_ticket_id))`,
    values,
  );

  return result.rows.map((r) => ({
    ticketId: String(r.ticket_id),
    total: Number(r.total) || 0,
    escalations: Number(r.escalations) || 0,
    lastReceivedAt: String(r.last_received_at),
  }));
}

/**
 * A page of stored mail, newest first.
 *
 * `offset` skips that many of the newest before returning `limit`, which is what lets the
 * reader ask for older mail without re-loading — and without carrying the whole mailbox in
 * one response, since each row carries its full body text.
 *
 * The tiebreak on id is what makes paging safe. Mail arriving in the same second is common
 * — a batch reply, a mailing list — and `received_at DESC` alone leaves their order up to
 * the planner, so the same message could appear on two pages while another appeared on
 * none. Ordering is unchanged for every other purpose: ties simply resolve newest-stored
 * first instead of arbitrarily.
 */
export async function listInboundEmails(params: {
  status?: string;
  regionCodes?: string[] | null;
  limit: number;
  offset?: number;
  /** One work order's mail only — what the report row's envelope marker opens. */
  ticketId?: string;
}): Promise<InboundEmailRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.status && params.status !== "ALL") {
    values.push(params.status);
    conditions.push(`status = $${values.length}`);
  }
  if (params.regionCodes) {
    values.push(params.regionCodes);
    conditions.push(`UPPER(region_code) = ANY($${values.length}::TEXT[])`);
  }
  // Filtered in SQL rather than in the reader: the mail for one WO can be older than the
  // page the list happens to hold, and a filter over the loaded page would show nothing
  // and look like there was no mail.
  const ticketId = params.ticketId?.trim();
  if (ticketId) {
    values.push(ticketId);
    conditions.push(`UPPER(TRIM(matched_ticket_id)) = UPPER(TRIM($${values.length}))`);
  }
  values.push(params.limit);
  const limitAt = values.length;
  values.push(Math.max(0, Math.trunc(params.offset ?? 0)));
  const offsetAt = values.length;

  const result = await query<Record<string, never>>(
    `SELECT id::TEXT, mailbox_email, region_code, message_id, imap_uid,
            from_email, from_name, subject, body_preview, body_text, has_attachments,
            received_at::TEXT, matched_ticket_id, matched_case_id,
            match_method, match_confidence, is_auto_reply,
            escalation_level, escalation_reasons, status, created_at::TEXT
       FROM inbound_emails
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY received_at DESC, id DESC
      LIMIT $${limitAt} OFFSET $${offsetAt}`,
    values,
  );

  return result.rows.map((r) => {
    const row = r as unknown as Record<string, string | number | boolean | null>;
    return {
      id: String(row.id),
      mailboxEmail: String(row.mailbox_email),
      regionCode: String(row.region_code),
      messageId: String(row.message_id),
      imapUid: row.imap_uid === null ? null : Number(row.imap_uid),
      fromEmail: String(row.from_email),
      fromName: String(row.from_name),
      subject: String(row.subject),
      bodyPreview: String(row.body_preview),
      bodyText: String(row.body_text ?? ""),
      bodyHtml: String(row.body_html ?? ""),
      hasAttachments: Boolean(row.has_attachments),
      receivedAt: String(row.received_at),
      matchedTicketId: String(row.matched_ticket_id),
      matchedCaseId: String(row.matched_case_id),
      matchMethod: String(row.match_method),
      matchConfidence: String(row.match_confidence),
      isAutoReply: Boolean(row.is_auto_reply),
      escalationLevel: String(row.escalation_level ?? "NONE"),
      escalationReasons: String(row.escalation_reasons ?? ""),
      status: String(row.status),
      createdAt: String(row.created_at),
    };
  });
}

export async function setInboundEmailStatus(
  id: string,
  status: string,
): Promise<void> {
  await query(`UPDATE inbound_emails SET status = $2 WHERE id = $1`, [id, status]);
}

/** The most recent report row for a ticket id — used to confirm a WO-number match. */
export async function findRowByTicketId(
  ticketId: string,
): Promise<{ ticketId: string; caseId: string; customerMail: string } | null> {
  const result = await query<{
    ticket_id: string;
    case_id: string | null;
    customer_mail: string | null;
  }>(
    `SELECT ticket_id, case_id, customer_mail
       FROM daily_call_plan_report_rows
      WHERE UPPER(TRIM(ticket_id)) = UPPER(TRIM($1))
        AND NOT is_excluded
      ORDER BY id DESC
      LIMIT 1`,
    [ticketId],
  );
  const row = result.rows[0];
  return row
    ? {
        ticketId: row.ticket_id,
        caseId: (row.case_id ?? "").trim(),
        customerMail: (row.customer_mail ?? "").trim(),
      }
    : null;
}

/** The most recent report row whose customer email matches the sender. */
export async function findRowByCustomerEmail(
  email: string,
): Promise<{ ticketId: string; caseId: string } | null> {
  const result = await query<{ ticket_id: string; case_id: string | null }>(
    `SELECT ticket_id, case_id
       FROM daily_call_plan_report_rows
      WHERE LOWER(TRIM(customer_mail)) = LOWER(TRIM($1))
        AND TRIM(COALESCE(customer_mail, '')) <> ''
        AND NOT is_excluded
      ORDER BY id DESC
      LIMIT 1`,
    [email],
  );
  const row = result.rows[0];
  return row ? { ticketId: row.ticket_id, caseId: (row.case_id ?? "").trim() } : null;
}

/** One inbound message by id — the reply path needs the mailbox, sender and match. */
export async function findInboundEmailById(
  id: string,
): Promise<InboundEmailRow | null> {
  const result = await query<Record<string, never>>(
    `SELECT id::TEXT, mailbox_email, region_code, message_id, imap_uid,
            from_email, from_name, subject, body_preview, body_text, body_html, has_attachments,
            received_at::TEXT, matched_ticket_id, matched_case_id,
            match_method, match_confidence, is_auto_reply,
            escalation_level, escalation_reasons, status, created_at::TEXT
       FROM inbound_emails WHERE id = $1`,
    [id],
  );
  const r = result.rows[0] as unknown as Record<string, string | number | boolean | null> | undefined;
  if (!r) return null;
  return {
    id: String(r.id),
    mailboxEmail: String(r.mailbox_email),
    regionCode: String(r.region_code),
    messageId: String(r.message_id),
    imapUid: r.imap_uid === null ? null : Number(r.imap_uid),
    fromEmail: String(r.from_email),
    fromName: String(r.from_name),
    subject: String(r.subject),
    bodyPreview: String(r.body_preview),
    bodyText: String(r.body_text ?? ""),
    bodyHtml: String(r.body_html ?? ""),
    hasAttachments: Boolean(r.has_attachments),
    receivedAt: String(r.received_at),
    matchedTicketId: String(r.matched_ticket_id),
    matchedCaseId: String(r.matched_case_id),
    matchMethod: String(r.match_method),
    matchConfidence: String(r.match_confidence),
    isAutoReply: Boolean(r.is_auto_reply),
    escalationLevel: String(r.escalation_level ?? "NONE"),
    escalationReasons: String(r.escalation_reasons ?? ""),
    status: String(r.status),
    createdAt: String(r.created_at),
  };
}

/**
 * The live facts for a call, used to fill a reply draft. Read from the most recent report
 * row for the ticket — the same row the dashboards show.
 */
export async function findCallFactsForTicket(ticketId: string): Promise<{
  ticketId: string;
  status: string;
  engineer: string;
  product: string;
  customerName: string;
} | null> {
  const result = await query<{
    ticket_id: string;
    rtpl_status: string | null;
    engineer: string | null;
    product: string | null;
    customer_name: string | null;
  }>(
    `SELECT ticket_id, rtpl_status, engineer, product, customer_name
       FROM daily_call_plan_report_rows
      WHERE UPPER(TRIM(ticket_id)) = UPPER(TRIM($1))
        AND NOT is_excluded
      ORDER BY id DESC
      LIMIT 1`,
    [ticketId],
  );
  const row = result.rows[0];
  return row
    ? {
        ticketId: row.ticket_id,
        status: (row.rtpl_status ?? "").trim(),
        engineer: (row.engineer ?? "").trim(),
        product: (row.product ?? "").trim(),
        customerName: (row.customer_name ?? "").trim(),
      }
    : null;
}
