import nodemailer from "nodemailer";
import {
  findReplyForInbound,
  markReplySent,
  upsertReplyDraft,
  type EmailReplyRow,
} from "../../repositories/emailReplyRepository.js";
import {
  findCallFactsForTicket,
  findInboundEmailById,
} from "../../repositories/inboundEmailRepository.js";
import { blockedReason, draftBody, replySubject } from "./replyDrafter.js";
import { archiveToSentFolder, buildRawMessage } from "./sentFolderArchiver.js";
import { mailboxPassword } from "./mailboxCredentials.js";
import { forbidden, notFound, unprocessableEntity } from "../../utils/httpError.js";

/**
 * Replying to a customer email — APPROVAL MODE.
 *
 * A draft is generated on request and stored; it only leaves the building when a human
 * calls `sendReply`. There is no scheduled path, no worker hook and no auto-send in this
 * file: the two unattended modes on `region_mailboxes.reply_mode` are recorded for later
 * and are not wired to anything yet.
 *
 * Every send re-checks the guards server-side. The browser is never trusted with them,
 * because the cost of getting this wrong is a wrong mail in a customer's inbox.
 */

/** Build (or rebuild) the draft for a message and store it. Never sends. */
export async function generateDraft(inboundId: string): Promise<EmailReplyRow> {
  const inbound = await findInboundEmailById(inboundId);
  if (!inbound) throw notFound("Message not found", { inboundId });

  const existing = await findReplyForInbound(inboundId);
  if (existing?.status === "SENT") {
    throw unprocessableEntity("A reply has already been sent for this message");
  }

  const blocked = blockedReason({
    isAutoReply: inbound.isAutoReply,
    alreadySent: false,
  });
  if (blocked) throw forbidden(blocked);

  const call = inbound.matchedTicketId
    ? await findCallFactsForTicket(inbound.matchedTicketId)
    : null;

  const body = draftBody({
    subject: inbound.subject,
    fromName: inbound.fromName,
    fromEmail: inbound.fromEmail,
    regionCode: inbound.regionCode,
    call,
    isAutoReply: inbound.isAutoReply,
    matchConfidence: inbound.matchConfidence,
  });

  return upsertReplyDraft({
    inboundEmailId: inboundId,
    // Always the original sender — the address is never taken from the request.
    toEmail: inbound.fromEmail,
    subject: replySubject(inbound.subject),
    body,
    generatedBy: "TEMPLATE",
  });
}

/** Save the human's edits to the draft. Still does not send. */
export async function saveDraft(input: {
  inboundId: string;
  subject: string;
  body: string;
}): Promise<EmailReplyRow> {
  const inbound = await findInboundEmailById(input.inboundId);
  if (!inbound) throw notFound("Message not found", { inboundId: input.inboundId });

  const existing = await findReplyForInbound(input.inboundId);
  if (existing?.status === "SENT") {
    throw unprocessableEntity("A reply has already been sent for this message");
  }

  return upsertReplyDraft({
    inboundEmailId: input.inboundId,
    toEmail: inbound.fromEmail,
    subject: input.subject.trim() || replySubject(inbound.subject),
    body: input.body,
    generatedBy: existing?.generatedBy ?? "TEMPLATE",
  });
}

/**
 * Send the approved draft. This is the ONLY function in the codebase that puts mail on the
 * wire, and it is reachable only from an authenticated user pressing Send.
 */
export async function sendReply(input: {
  inboundId: string;
  approvedByUserId: string;
}): Promise<EmailReplyRow> {
  const inbound = await findInboundEmailById(input.inboundId);
  if (!inbound) throw notFound("Message not found", { inboundId: input.inboundId });

  const draft = await findReplyForInbound(input.inboundId);
  if (!draft) throw unprocessableEntity("There is no draft to send");

  // Re-check every guard at the moment of sending, not just when the draft was made.
  const blocked = blockedReason({
    isAutoReply: inbound.isAutoReply,
    alreadySent: draft.status === "SENT",
  });
  if (blocked) throw forbidden(blocked);

  if (!draft.body.trim()) throw unprocessableEntity("The reply body is empty");
  if (!draft.toEmail.includes("@")) {
    throw unprocessableEntity("The recipient address is not valid", {
      toEmail: draft.toEmail,
    });
  }

  const host = process.env.MAIL_SMTP_HOST ?? "";
  const port = Number(process.env.MAIL_SMTP_PORT ?? 465);
  const pass = mailboxPassword(inbound.mailboxEmail);
  if (!host || !pass) {
    throw unprocessableEntity("MAIL_SMTP_HOST / MAIL_PASSWORD are not configured");
  }

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    // Send AS the region mailbox the customer wrote to, so the thread stays in one place.
    auth: { user: inbound.mailboxEmail, pass },
    tls: { rejectUnauthorized: false },
  });

  try {
    // Compiled once, then sent and filed, so the copy in the mailbox's Sent folder is
    // byte-for-byte the mail the customer received. Filing is best effort and deliberately
    // not awaited — the reply has already gone by then.
    const raw = await buildRawMessage({
      from: inbound.mailboxEmail,
      to: draft.toEmail,
      subject: draft.subject,
      text: draft.body,
      // Threads the reply under the customer's message in their client.
      inReplyTo: inbound.messageId,
      references: inbound.messageId,
    });
    await transport.sendMail({
      raw,
      envelope: { from: inbound.mailboxEmail, to: [draft.toEmail] },
    });
    void archiveToSentFolder({ mailboxEmail: inbound.mailboxEmail, raw });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markReplySent({ id: draft.id, status: "FAILED", approvedBy: null, error: message });
    throw unprocessableEntity(`Send failed: ${message}`);
  }

  return markReplySent({
    id: draft.id,
    status: "SENT",
    approvedBy: input.approvedByUserId,
    error: "",
  });
}
