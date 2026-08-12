import { Router } from "express";
import {
  listInboundEmailsController,
  pollInboundEmailsController,
  setInboundEmailStatusController,
} from "../controllers/inboundEmailController.js";
import {
  generateReplyController,
  getReplyController,
  saveReplyController,
  sendReplyController,
} from "../controllers/emailReplyController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";

/**
 * Customer Emails — Stage 1: read + triage only. There is deliberately no send route.
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
