import { query } from "../config/database.js";

/**
 * Storage for Stage 2 replies. Self-contained; the only rows it touches are this feature's
 * own `email_replies`.
 */

export interface EmailReplyRow {
  id: string;
  inboundEmailId: string;
  toEmail: string;
  subject: string;
  body: string;
  generatedBy: string;
  /** 'DRAFT' | 'SENT' | 'FAILED' */
  status: string;
  approvedBy: string | null;
  sentAt: string | null;
  error: string;
}

function mapRow(row: Record<string, unknown>): EmailReplyRow {
  return {
    id: String(row.id),
    inboundEmailId: String(row.inbound_email_id),
    toEmail: String(row.to_email),
    subject: String(row.subject),
    body: String(row.body),
    generatedBy: String(row.generated_by),
    status: String(row.status),
    approvedBy: row.approved_by === null ? null : String(row.approved_by),
    sentAt: row.sent_at === null ? null : String(row.sent_at),
    error: String(row.error ?? ""),
  };
}

const SELECT = `id::TEXT, inbound_email_id::TEXT, to_email, subject, body,
                generated_by, status, approved_by::TEXT, sent_at::TEXT, error`;

export async function findReplyForInbound(
  inboundEmailId: string,
): Promise<EmailReplyRow | null> {
  const result = await query(
    `SELECT ${SELECT} FROM email_replies WHERE inbound_email_id = $1`,
    [inboundEmailId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

/** Replies for a page of messages, so the list can show which ones are answered. */
export async function findRepliesForInbounds(
  inboundEmailIds: readonly string[],
): Promise<EmailReplyRow[]> {
  if (inboundEmailIds.length === 0) return [];
  const result = await query(
    `SELECT ${SELECT} FROM email_replies WHERE inbound_email_id = ANY($1::UUID[])`,
    [[...inboundEmailIds]],
  );
  return (result.rows as Record<string, unknown>[]).map(mapRow);
}

/**
 * Create or replace the draft for a message. A SENT reply is never overwritten — the
 * WHERE clause is the last line of defence behind the service's own check.
 */
export async function upsertReplyDraft(input: {
  inboundEmailId: string;
  toEmail: string;
  subject: string;
  body: string;
  generatedBy: string;
}): Promise<EmailReplyRow> {
  const result = await query(
    `INSERT INTO email_replies (inbound_email_id, to_email, subject, body, generated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (inbound_email_id) DO UPDATE
       SET to_email = EXCLUDED.to_email,
           subject = EXCLUDED.subject,
           body = EXCLUDED.body,
           generated_by = EXCLUDED.generated_by,
           updated_at = NOW()
       WHERE email_replies.status <> 'SENT'
     RETURNING ${SELECT}`,
    [input.inboundEmailId, input.toEmail, input.subject, input.body, input.generatedBy],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row) return mapRow(row);
  // The upsert was skipped because the reply is already SENT; return what is there.
  const existing = await findReplyForInbound(input.inboundEmailId);
  if (!existing) throw new Error("Failed to store the reply draft");
  return existing;
}

export async function markReplySent(input: {
  id: string;
  status: "SENT" | "FAILED";
  approvedBy: string | null;
  error: string;
}): Promise<EmailReplyRow> {
  const result = await query(
    `UPDATE email_replies
        SET status = $2,
            approved_by = $3,
            error = $4,
            sent_at = CASE WHEN $2 = 'SENT' THEN NOW() ELSE sent_at END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${SELECT}`,
    [input.id, input.status, input.approvedBy, input.error],
  );
  return mapRow(result.rows[0] as Record<string, unknown>);
}
