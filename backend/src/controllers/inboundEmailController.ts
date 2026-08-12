import type { RequestHandler } from "express";
import {
  findAttachmentContent,
  findAttachmentsForEmail,
  findInboundEmailById,
  listActiveMailboxes,
  listInboundEmails,
  setInboundEmailStatus,
} from "../repositories/inboundEmailRepository.js";
import { pollAllMailboxes } from "../services/inboundEmail/inboundEmailService.js";
import { resolveInlineImages } from "../services/inboundEmail/htmlSanitizer.js";
import {
  findAllowedRegionsForUser,
  requireCurrentUser,
} from "../services/rbac/regionAccessService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { notFound, unprocessableEntity } from "../utils/httpError.js";

/**
 * Customer Emails — Stage 1 is read + triage only. There is no send endpoint here on
 * purpose; replies are a later stage.
 */

const ALLOWED_STATUS = new Set(["NEW", "REVIEWED", "IGNORED"]);

/** The inbox: newest first, region-scoped, with the mailbox poll health alongside. */
export const listInboundEmailsController: RequestHandler = asyncHandler(
  async (request, response) => {
    const user = requireCurrentUser(request.currentUser);

    const regions = await findAllowedRegionsForUser(user);
    const regionCodes =
      regions === null ? null : regions.map((r) => r.name.trim().toUpperCase());

    const status = String(request.query.status ?? "ALL").trim().toUpperCase();
    const parsedLimit = Number(request.query.limit ?? 100);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 500)
      : 100;

    const [rows, mailboxes] = await Promise.all([
      listInboundEmails({ status, regionCodes, limit }),
      listActiveMailboxes(),
    ]);

    response.json({
      data: {
        rows,
        mailboxes: mailboxes.filter(
          (m) => !regionCodes || regionCodes.includes(m.regionCode.toUpperCase()),
        ),
      },
    });
  },
);

/** Triage: mark a message reviewed or ignored. Does not touch the mailbox itself. */
export const setInboundEmailStatusController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireCurrentUser(request.currentUser);

    const id = String(request.params.id ?? "").trim();
    const status = String((request.body ?? {}).status ?? "").trim().toUpperCase();
    if (!id) throw unprocessableEntity("Missing email id");
    if (!ALLOWED_STATUS.has(status)) {
      throw unprocessableEntity("status must be NEW, REVIEWED or IGNORED", { status });
    }

    await setInboundEmailStatus(id, status);
    response.json({ data: { id, status } });
  },
);

/**
 * Run a poll now instead of waiting for the worker. Still read-only — it fetches and
 * stores, and cannot send anything.
 */
export const pollInboundEmailsController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireCurrentUser(request.currentUser);
    response.json({ data: { results: await pollAllMailboxes() } });
  },
);

/**
 * Is this message inside the caller's regions?
 *
 * The list route filters by region in SQL, but the detail and attachment routes are
 * addressed by id — without this, a Region Admin who guessed an id could read another
 * region's mail. Called before anything is returned.
 */
async function assertMessageInScope(
  user: Parameters<typeof findAllowedRegionsForUser>[0],
  id: string,
): Promise<NonNullable<Awaited<ReturnType<typeof findInboundEmailById>>>> {
  const message = await findInboundEmailById(id);
  if (!message) throw notFound("Message not found", { id });

  const regions = await findAllowedRegionsForUser(user);
  if (regions !== null) {
    const allowed = regions.map((r) => r.name.trim().toUpperCase());
    if (!allowed.includes(message.regionCode.trim().toUpperCase())) {
      throw notFound("Message not found", { id });
    }
  }
  return message;
}

/**
 * One message with everything the reading pane needs: the sender's own HTML (already
 * sanitised at ingest) and the list of files, with every `cid:` reference rewritten to
 * point at the attachment route so inline pictures load.
 */
export const getInboundEmailController: RequestHandler = asyncHandler(
  async (request, response) => {
    const user = requireCurrentUser(request.currentUser);
    const id = String(request.params.id ?? "").trim();
    if (!id) throw unprocessableEntity("Missing email id");

    const message = await assertMessageInScope(user, id);
    const attachments = await findAttachmentsForEmail(id);

    const byContentId = new Map(
      attachments.filter((a) => a.contentId).map((a) => [a.contentId, a.id]),
    );
    const bodyHtml = resolveInlineImages(message.bodyHtml, (contentId) => {
      const attachmentId = byContentId.get(contentId);
      return attachmentId
        ? `/api/v1/customer-emails/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`
        : null;
    });

    // Inline pictures are returned alongside the rest: the browser cannot put an
    // Authorization header on an <img>, so the reader fetches each one itself and swaps in
    // an object URL. It needs their ids to do that. `isInline` tells it which are body
    // pictures and which belong on the paperclip list.
    response.json({
      data: { message: { ...message, bodyHtml }, attachments },
    });
  },
);

/** The bytes of one attachment. Scoped by its parent message, which was checked above. */
export const getInboundEmailAttachmentController: RequestHandler = asyncHandler(
  async (request, response) => {
    const user = requireCurrentUser(request.currentUser);
    const id = String(request.params.id ?? "").trim();
    const attachmentId = String(request.params.attachmentId ?? "").trim();
    if (!id || !attachmentId) throw unprocessableEntity("Missing attachment id");

    await assertMessageInScope(user, id);
    const file = await findAttachmentContent(id, attachmentId);
    if (!file) throw notFound("Attachment not found", { attachmentId });

    // inline so a signature image renders in the reading pane; the download button on the
    // frontend adds its own `download` attribute for the ones that are real attachments.
    response.setHeader("Content-Type", file.mimeType);
    response.setHeader(
      "Content-Disposition",
      `inline; filename="${file.filename.replace(/["\\]/g, "")}"`,
    );
    // Attacker-supplied bytes: never let a browser re-interpret the declared type.
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.send(file.content);
  },
);
