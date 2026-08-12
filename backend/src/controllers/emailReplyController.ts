import type { RequestHandler } from "express";
import { findReplyForInbound } from "../repositories/emailReplyRepository.js";
import {
  generateDraft,
  saveDraft,
  sendReply,
} from "../services/inboundEmail/replyService.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { unprocessableEntity } from "../utils/httpError.js";

/**
 * Reply endpoints — APPROVAL MODE.
 *
 * Draft and save never touch SMTP. Send is the single endpoint that puts mail on the wire,
 * and it records the user who pressed it as the approver.
 */

function requireId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!id) throw unprocessableEntity("Missing message id");
  return id;
}

/** The stored draft for a message, if one has been generated. */
export const getReplyController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireCurrentUser(request.currentUser);
    response.json({ data: await findReplyForInbound(requireId(request.params.id)) });
  },
);

/** Build a fresh draft from the live call status. Does not send. */
export const generateReplyController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireCurrentUser(request.currentUser);
    response.json({ data: await generateDraft(requireId(request.params.id)) });
  },
);

/** Save the human's edits. Does not send. */
export const saveReplyController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireCurrentUser(request.currentUser);
    const body = (request.body ?? {}) as Record<string, unknown>;
    response.json({
      data: await saveDraft({
        inboundId: requireId(request.params.id),
        subject: String(body.subject ?? ""),
        body: String(body.body ?? ""),
      }),
    });
  },
);

/**
 * Send the approved draft. The ONLY route in the app that emails a customer; it exists
 * because a human clicked Send, and the user id is stored as the approver.
 */
export const sendReplyController: RequestHandler = asyncHandler(
  async (request, response) => {
    const user = requireCurrentUser(request.currentUser);
    response.json({
      data: await sendReply({
        inboundId: requireId(request.params.id),
        approvedByUserId: user.id,
      }),
    });
  },
);
