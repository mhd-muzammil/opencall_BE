import type { RequestHandler } from "express";
import { listOutboundEmails } from "../repositories/outboundEmailRepository.js";
import { sendComposedEmail } from "../services/inboundEmail/composeService.js";
import {
  findAllowedRegionsForUser,
  requireCurrentUser,
} from "../services/rbac/regionAccessService.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Compose — the outbound half of Customer Emails.
 *
 * Both routes are mounted behind requireRole(["SUPER_ADMIN", "REGION_ADMIN"]); the region
 * scope below is the second, finer check that decides WHICH mailbox this particular admin
 * may write as.
 */

/** Region names this session may act for; null means unrestricted (Super Admin). */
async function scopeFor(
  user: Parameters<typeof findAllowedRegionsForUser>[0],
): Promise<string[] | null> {
  const regions = await findAllowedRegionsForUser(user);
  return regions === null ? null : regions.map((r) => r.name.trim().toUpperCase());
}

/**
 * Send. Multipart, because attachments ride along with the fields.
 *
 * Nothing here decides on its own to email anyone: this handler runs because a person
 * filled in the form and pressed Send.
 */
export const composeEmailController: RequestHandler = asyncHandler(
  async (request, response) => {
    const user = requireCurrentUser(request.currentUser);
    const allowedRegionCodes = await scopeFor(user);

    const files = Array.isArray(request.files) ? request.files : [];
    const body = request.body as Record<string, unknown>;

    const result = await sendComposedEmail({
      regionCode: String(body.regionCode ?? ""),
      to: String(body.to ?? ""),
      cc: String(body.cc ?? ""),
      subject: String(body.subject ?? ""),
      body: String(body.body ?? ""),
      inReplyToId: body.inReplyToId ? String(body.inReplyToId) : null,
      attachments: files.map((file) => ({
        filename: file.originalname,
        mimeType: file.mimetype || "application/octet-stream",
        content: file.buffer,
      })),
      allowedRegionCodes,
      sentByUserId: user.id,
    });

    response.status(201).json({ data: result });
  },
);

/** The Sent list, scoped to the caller's regions exactly as the inbox is. */
export const listOutboundEmailsController: RequestHandler = asyncHandler(
  async (request, response) => {
    const user = requireCurrentUser(request.currentUser);
    const regionCodes = await scopeFor(user);

    const parsedLimit = Number(request.query.limit ?? 100);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 500)
      : 100;

    const rows = await listOutboundEmails({ regionCodes, limit });
    response.json({ data: { rows } });
  },
);
