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
  receivedAt: string;
  matchedTicketId: string;
  matchedCaseId: string;
  matchMethod: string;
  matchConfidence: string;
  isAutoReply: boolean;
  escalationLevel: string;
  escalationReasons: string;
}

/** Insert a message; a re-poll of the same message is a no-op. Returns true when new. */
export async function insertInboundEmail(
  input: InboundEmailInput,
): Promise<boolean> {
  const result = await query<{ id: string }>(
    `INSERT INTO inbound_emails (
       mailbox_email, region_code, message_id, imap_uid,
       from_email, from_name, subject, body_preview, body_text, received_at,
       matched_ticket_id, matched_case_id, match_method, match_confidence, is_auto_reply,
       escalation_level, escalation_reasons
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
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
  return result.rows.length > 0;
}

export interface InboundEmailRow extends InboundEmailInput {
  id: string;
  status: string;
  createdAt: string;
}

export async function listInboundEmails(params: {
  status?: string;
  regionCodes?: string[] | null;
  limit: number;
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
  values.push(params.limit);

  const result = await query<Record<string, never>>(
    `SELECT id::TEXT, mailbox_email, region_code, message_id, imap_uid,
            from_email, from_name, subject, body_preview, body_text,
            received_at::TEXT, matched_ticket_id, matched_case_id,
            match_method, match_confidence, is_auto_reply,
            escalation_level, escalation_reasons, status, created_at::TEXT
       FROM inbound_emails
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY received_at DESC
      LIMIT $${values.length}`,
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
            from_email, from_name, subject, body_preview, body_text,
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
