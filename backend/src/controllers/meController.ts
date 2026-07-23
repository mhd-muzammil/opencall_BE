import type { RequestHandler } from "express";
import { findManagedUserById } from "../repositories/userRepository.js";
import {
  findAllowedRegionIdsForUser,
  requireCurrentUser,
} from "../services/rbac/regionAccessService.js";
import { changeOwnPassword } from "../services/userManagement/userManagementService.js";
import { recordActivity } from "../services/audit/activityLogger.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { selfPasswordChangeSchema } from "../validators/adminUserValidators.js";

export const getMeController: RequestHandler = asyncHandler(
  async (request, response) => {
    const current = requireCurrentUser(request.currentUser);
    const user = await findManagedUserById(current.id);
    if (!user) {
      response.json({ data: null });
      return;
    }

    // The extra regions are resolved here rather than in authMiddleware so the
    // per-request auth path stays a single users lookup; /me runs once per
    // session restore, so one user_regions query here is the cheap side.
    // allowedRegionIds: null = unrestricted (SUPER_ADMIN); otherwise primary
    // first plus the user_regions extras — the same authoritative set every
    // read and write path enforces.
    const allowedRegionIds = await findAllowedRegionIdsForUser(current);
    const additionalRegionIds =
      allowedRegionIds?.filter((regionId) => regionId !== current.regionId) ??
      [];
    response.json({
      data: { ...user, additionalRegionIds, allowedRegionIds },
    });
  },
);

export const changeOwnPasswordController: RequestHandler = asyncHandler(
  async (request, response) => {
    const current = requireCurrentUser(request.currentUser);
    const input = selfPasswordChangeSchema.parse(request.body);
    await changeOwnPassword({
      userId: current.id,
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
    });
    recordActivity({
      eventType: "PASSWORD_CHANGED",
      actor: {
        id: current.id,
        email: current.email,
        role: current.role,
      },
      regionId: current.regionId,
      targetType: "user",
      targetId: current.id,
      request,
    });
    response.json({ data: { ok: true } });
  },
);
