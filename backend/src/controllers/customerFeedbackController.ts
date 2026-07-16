import { z } from "zod";
import type { Request, RequestHandler } from "express";
import {
  CALL_STATUS_OPTIONS,
  CUSTOMER_FEEDBACK_OPTIONS,
} from "@opencall/shared";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, forbidden } from "../utils/httpError.js";
import { upsertCustomerFeedback } from "../repositories/customerFeedbackRepository.js";

// Uniform dropdown values only (plus optional free-text remarks). An empty string is
// allowed so a partially-filled feedback can still be saved; unknown values are rejected.
const callStatusSchema = z
  .string()
  .trim()
  .refine((v) => v === "" || CALL_STATUS_OPTIONS.includes(v), {
    message: "Unknown call status",
  });
const feedbackValueSchema = z
  .string()
  .trim()
  .refine((v) => v === "" || CUSTOMER_FEEDBACK_OPTIONS.includes(v), {
    message: "Unknown feedback value",
  });

const feedbackSchema = z
  .object({
    woId: z.string().trim().max(200).optional().default(""),
    caseId: z.string().trim().max(200).optional().default(""),
    callStatus: callStatusSchema.optional().default(""),
    feedback: feedbackValueSchema.optional().default(""),
    remarks: z.string().trim().max(2000).optional().default(""),
  })
  .refine((v) => v.woId.length > 0 || v.caseId.length > 0, {
    message: "A WO id or Case id is required",
  })
  .refine((v) => v.callStatus.length > 0 || v.feedback.length > 0, {
    message: "Pick a call status or a feedback value",
  });

/**
 * Resolves who is saving the feedback. Accepts both a regular user (request.currentUser)
 * and a special-access principal (request.specialAccess), since both may reach this via
 * requirePrincipal. A special-access credential must hold the `edit` permission level.
 */
function resolveEditor(request: Request): string {
  if (request.currentUser) {
    return request.currentUser.email ?? request.currentUser.username ?? "user";
  }
  if (request.specialAccess) {
    if (request.specialAccess.permissionLevel !== "edit") {
      throw forbidden("This credential is view-only and cannot save feedback");
    }
    return `special-access:${request.specialAccess.username}`;
  }
  throw forbidden("Authentication required");
}

export const saveCustomerFeedbackController: RequestHandler = asyncHandler(
  async (request, response) => {
    const editor = resolveEditor(request);
    const parsed = feedbackSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("Invalid feedback", parsed.error.flatten());
    }

    await upsertCustomerFeedback({
      woId: parsed.data.woId,
      caseId: parsed.data.caseId,
      callStatus: parsed.data.callStatus,
      feedback: parsed.data.feedback,
      remarks: parsed.data.remarks,
      updatedBy: editor,
    });

    response.status(201).json({ data: { ok: true } });
  },
);
