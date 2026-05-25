import type { RequestHandler } from "express";
import { findManagedUserById } from "../repositories/userRepository.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import { changeOwnPassword } from "../services/userManagement/userManagementService.js";
import { recordActivity } from "../services/audit/activityLogger.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { selfPasswordChangeSchema } from "../validators/adminUserValidators.js";

export const getMeController: RequestHandler = asyncHandler(
  async (request, response) => {
    const current = requireCurrentUser(request.currentUser);
    const user = await findManagedUserById(current.id);
    response.json({ data: user });
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
