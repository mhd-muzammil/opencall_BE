import nodemailer from "nodemailer";
import {
  findInboundEmailById,
  listActiveMailboxes,
} from "../../repositories/inboundEmailRepository.js";
import {
  addOutboundAttachment,
  createOutboundEmail,
  markOutboundSent,
  type OutboundEmailRow,
} from "../../repositories/outboundEmailRepository.js";
import { forbidden, unprocessableEntity } from "../../utils/httpError.js";
import { checkCompose } from "./composeValidator.js";
import { archiveToSentFolder, buildRawMessage } from "./sentFolderArchiver.js";

/**
 * Compose — send a mail from a region mailbox to anyone.
 *
 * This is the ONLY free-form outbound path in the system, and it exists only behind a
 * human pressing Send: there is no scheduler, no worker and no automatic caller. Replies
 * (`replyService`) stay as they were — locked to answering an inbound message.
 *
 * Two guards do the real work here and neither is skippable:
 *   1. the sending mailbox must be one this user's regions actually own, re-derived from
 *      the user on every request rather than taken from the form;
 *   2. the audit row is written BEFORE the SMTP call, so a mail that reaches a customer is
 *      always attributable even if the process dies immediately afterwards.
 */

export interface ComposeAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface ComposeRequest {
  regionCode: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  inReplyToId: string | null;
  attachments: readonly ComposeAttachment[];
  /** Null when the caller is unrestricted (Super Admin); otherwise their region names. */
  allowedRegionCodes: readonly string[] | null;
  sentByUserId: string;
}

export interface ComposeResult {
  id: string;
  fromEmail: string;
  to: string[];
  cc: string[];
  attachmentCount: number;
}

export async function sendComposedEmail(
  request: ComposeRequest,
): Promise<ComposeResult> {
  const regionCode = request.regionCode.trim().toUpperCase();
  if (!regionCode) throw unprocessableEntity("Choose which mailbox to send from");

  // Region scope FIRST: a Region Admin must not be able to write as another region even
  // by editing the request, so the mailbox is resolved from the server's own list.
  if (
    request.allowedRegionCodes !== null &&
    !request.allowedRegionCodes.some((code) => code.trim().toUpperCase() === regionCode)
  ) {
    throw forbidden("You do not have access to that region's mailbox");
  }

  const mailboxes = await listActiveMailboxes();
  const mailbox = mailboxes.find(
    (box) => box.regionCode.trim().toUpperCase() === regionCode,
  );
  if (!mailbox) {
    throw unprocessableEntity(`No active mailbox is configured for ${regionCode}`);
  }

  const attachmentBytes = request.attachments.reduce(
    (total, file) => total + file.content.length,
    0,
  );

  const check = checkCompose({
    fromEmail: mailbox.email,
    to: request.to,
    cc: request.cc,
    subject: request.subject,
    body: request.body,
    attachmentBytes,
  });
  if (check.error) throw unprocessableEntity(check.error);

  // Threading, when Compose was opened from a message. A missing or out-of-scope id is
  // simply not threaded rather than being an error — the mail itself is still valid.
  let inReplyToMessageId = "";
  let inReplyToId: string | null = null;
  if (request.inReplyToId) {
    const inbound = await findInboundEmailById(request.inReplyToId);
    if (inbound && inbound.regionCode.trim().toUpperCase() === regionCode) {
      inReplyToId = request.inReplyToId;
      inReplyToMessageId = inbound.messageId;
    }
  }

  const host = process.env.MAIL_SMTP_HOST ?? "";
  const port = Number(process.env.MAIL_SMTP_PORT ?? 465);
  const pass = process.env.MAIL_PASSWORD ?? "";
  if (!host || !pass) {
    throw unprocessableEntity("MAIL_SMTP_HOST / MAIL_PASSWORD are not configured");
  }

  const id = await createOutboundEmail({
    regionCode,
    fromEmail: mailbox.email,
    toEmails: check.to.join(", "),
    ccEmails: check.cc.join(", "),
    subject: request.subject.trim(),
    bodyText: request.body,
    inReplyToId,
    sentBy: request.sentByUserId,
  });

  for (const file of request.attachments) {
    await addOutboundAttachment(id, {
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.content.length,
      content: file.content,
    });
  }

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user: mailbox.email, pass },
    // The mailboxes sit on shared hosting with a self-signed chain on some hostnames,
    // matching what the IMAP side already does.
    tls: { rejectUnauthorized: false },
  });

  const mailOptions = {
    from: mailbox.email,
    to: check.to.join(", "),
    ...(check.cc.length > 0 ? { cc: check.cc.join(", ") } : {}),
    subject: request.subject.trim(),
    text: request.body,
    ...(inReplyToMessageId
      ? { inReplyTo: inReplyToMessageId, references: inReplyToMessageId }
      : {}),
    attachments: request.attachments.map((file) => ({
      filename: file.filename,
      content: file.content,
      contentType: file.mimeType,
    })),
  };

  try {
    // Compiled ONCE and then both sent and filed. Letting nodemailer build the outgoing
    // copy separately would give the archived one a different Message-ID, and the mail in
    // the Sent folder would no longer be the mail the customer received.
    const raw = await buildRawMessage(mailOptions);
    const info = await transport.sendMail({
      raw,
      envelope: { from: mailbox.email, to: [...check.to, ...check.cc] },
    });
    await markOutboundSent({
      id,
      status: "SENT",
      messageId: String(info.messageId ?? ""),
      error: "",
    });

    // After the record is settled: the mail has already gone, so a filing failure must not
    // turn into "send failed" and invite someone to send it twice.
    void archiveToSentFolder({ mailboxEmail: mailbox.email, raw });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markOutboundSent({ id, status: "FAILED", messageId: "", error: message });
    throw unprocessableEntity(`Send failed: ${message}`);
  }

  return {
    id,
    fromEmail: mailbox.email,
    to: check.to,
    cc: check.cc,
    attachmentCount: request.attachments.length,
  };
}

export type { OutboundEmailRow };
