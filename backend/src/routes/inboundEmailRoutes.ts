import { Router } from "express";
import {
  getInboundEmailAttachmentController,
  getInboundEmailController,
  listInboundEmailsController,
  pollInboundEmailsController,
  setInboundEmailStatusController,
  listInboundEmailWoSummaryController,
} from "../controllers/inboundEmailController.js";
import {
  composeEmailController,
  listOutboundEmailsController,
} from "../controllers/outboundEmailController.js";
import { composeAttachmentMiddleware } from "../middlewares/composeAttachmentMiddleware.js";
import {
  generateReplyController,
  getReplyController,
  saveReplyController,
  sendReplyController,
} from "../controllers/emailReplyController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";

/**
 * Customer Emails.
 *
 * Two outbound routes exist and both are human-driven: `/:id/reply/send` answers a message
 * that arrived, and `/compose` writes a new one. Neither has a scheduled or worker caller —
 * the mail worker only ever reads. Every route here is behind SUPER_ADMIN / REGION_ADMIN,
 * and the handlers re-check region scope by id, because a role alone does not say WHICH
 * region's mail you may see or send as.
 */
export const inboundEmailRouter = Router();

inboundEmailRouter.get(
  "/",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  listInboundEmailsController,
);

inboundEmailRouter.patch(
  "/:id/status",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  setInboundEmailStatusController,
);

inboundEmailRouter.post(
  "/poll",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN"]),
  pollInboundEmailsController,
);

// --- Compose: a new mail to anyone, from a region mailbox ---
// Registered BEFORE "/:id" so the literal paths are not swallowed by the id parameter.
inboundEmailRouter.get(
  "/sent",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  listOutboundEmailsController,
);

inboundEmailRouter.post(
  "/compose",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  composeAttachmentMiddleware,
  composeEmailController,
);

// --- Which work orders have mail, for the report table's envelope marker ---
// Also BEFORE "/:id", or "wo-summary" is read as a message id.
inboundEmailRouter.get(
  "/wo-summary",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  listInboundEmailWoSummaryController,
);

// --- One message, for the reading pane: original HTML + attachment list ---
inboundEmailRouter.get(
  "/:id",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  getInboundEmailController,
);

inboundEmailRouter.get(
  "/:id/attachments/:attachmentId",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  getInboundEmailAttachmentController,
);

// --- Stage 2 replies: APPROVAL MODE ---
// Draft and save never touch SMTP. Only the send route emails a customer, and it runs
// because a human pressed Send — there is no scheduled or automatic path to it.
inboundEmailRouter.get(
  "/:id/reply",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  getReplyController,
);

inboundEmailRouter.post(
  "/:id/reply/draft",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  generateReplyController,
);

inboundEmailRouter.put(
  "/:id/reply",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  saveReplyController,
);

inboundEmailRouter.post(
  "/:id/reply/send",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  sendReplyController,
);
