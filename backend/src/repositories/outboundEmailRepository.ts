import { query } from "../config/database.js";

/**
 * Storage for Compose — mail written in OpenCall and sent from a region mailbox.
 *
 * Kept separate from `emailReplyRepository`: a reply can only ever answer a message that
 * arrived, addressed to its original sender, and that restriction is a safety property
 * worth keeping intact. This table is the deliberate free-form outbound path, and every
 * row names the person who sent it.
 */

export interface OutboundEmailRow {
  id: string;
  regionCode: string;
  fromEmail: string;
  toEmails: string;
  ccEmails: string;
  subject: string;
  bodyText: string;
  inReplyToId: string | null;
  status: string;
  messageId: string;
  error: string;
  sentBy: string;
  sentByName: string;
  sentAt: string | null;
  createdAt: string;
  attachmentCount: number;
}

interface RawRow {
  id: string;
  region_code: string;
  from_email: string;
  to_emails: string;
  cc_emails: string;
  subject: string;
  body_text: string;
  in_reply_to_id: string | null;
  status: string;
  message_id: string;
  error: string;
  sent_by: string;
  sent_by_name: string | null;
  sent_at: string | null;
  created_at: string;
  attachment_count: string | number;
}

function toRow(raw: RawRow): OutboundEmailRow {
  return {
    id: String(raw.id),
    regionCode: String(raw.region_code ?? ""),
    fromEmail: String(raw.from_email ?? ""),
    toEmails: String(raw.to_emails ?? ""),
    ccEmails: String(raw.cc_emails ?? ""),
    subject: String(raw.subject ?? ""),
    bodyText: String(raw.body_text ?? ""),
    inReplyToId: raw.in_reply_to_id ? String(raw.in_reply_to_id) : null,
    status: String(raw.status ?? ""),
    messageId: String(raw.message_id ?? ""),
    error: String(raw.error ?? ""),
    sentBy: String(raw.sent_by ?? ""),
    sentByName: String(raw.sent_by_name ?? ""),
    sentAt: raw.sent_at ? String(raw.sent_at) : null,
    createdAt: String(raw.created_at),
    attachmentCount: Number(raw.attachment_count) || 0,
  };
}

/**
 * Write the audit row BEFORE the SMTP call.
 *
 * Order matters: if the process dies mid-send there must still be a record that someone
 * tried, rather than a mail sitting in a customer's inbox that this system has never heard
 * of. The row starts QUEUED and is resolved by `markOutboundSent`.
 */
export async function createOutboundEmail(input: {
  regionCode: string;
  fromEmail: string;
  toEmails: string;
  ccEmails: string;
  subject: string;
  bodyText: string;
  inReplyToId: string | null;
  sentBy: string;
}): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO outbound_emails
       (region_code, from_email, to_emails, cc_emails, subject, body_text,
        in_reply_to_id, sent_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'QUEUED')
     RETURNING id::TEXT`,
    [
      input.regionCode,
      input.fromEmail,
      input.toEmails,
      input.ccEmails,
      input.subject,
      input.bodyText,
      input.inReplyToId,
      input.sentBy,
    ],
  );
  return String(result.rows[0]!.id);
}

export async function addOutboundAttachment(
  outboundEmailId: string,
  attachment: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    content: Buffer;
  },
): Promise<void> {
  await query(
    `INSERT INTO outbound_email_attachments
       (outbound_email_id, filename, mime_type, size_bytes, content)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      outboundEmailId,
      attachment.filename,
      attachment.mimeType,
      attachment.sizeBytes,
      attachment.content,
    ],
  );
}

export async function markOutboundSent(input: {
  id: string;
  status: "SENT" | "FAILED";
  messageId: string;
  error: string;
}): Promise<void> {
  await query(
    `UPDATE outbound_emails
        SET status = $2,
            message_id = $3,
            error = $4,
            sent_at = CASE WHEN $2 = 'SENT' THEN NOW() ELSE sent_at END
      WHERE id = $1`,
    [input.id, input.status, input.messageId, input.error],
  );
}

/** The Sent list, region-scoped the same way the inbox is. */
export async function listOutboundEmails(params: {
  regionCodes?: string[] | null;
  limit: number;
}): Promise<OutboundEmailRow[]> {
  const values: unknown[] = [];
  let where = "";
  if (params.regionCodes) {
    values.push(params.regionCodes);
    where = `WHERE UPPER(o.region_code) = ANY($${values.length}::TEXT[])`;
  }
  values.push(params.limit);

  const result = await query<RawRow>(
    `SELECT o.id::TEXT, o.region_code, o.from_email, o.to_emails, o.cc_emails,
            o.subject, o.body_text, o.in_reply_to_id::TEXT, o.status, o.message_id,
            o.error, o.sent_by::TEXT, u.username AS sent_by_name,
            o.sent_at::TEXT, o.created_at::TEXT,
            (SELECT COUNT(*) FROM outbound_email_attachments a
              WHERE a.outbound_email_id = o.id) AS attachment_count
       FROM outbound_emails o
       LEFT JOIN users u ON u.id = o.sent_by
       ${where}
      ORDER BY o.created_at DESC
      LIMIT $${values.length}`,
    values,
  );
  return result.rows.map(toRow);
}
