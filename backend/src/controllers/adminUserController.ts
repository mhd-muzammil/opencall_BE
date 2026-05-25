import type { RequestHandler, Request } from "express";
import type { AuthenticatedUser } from "../types/auth.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import { recordActivity } from "../services/audit/activityLogger.js";
import type { ActivityEventType } from "../repositories/activityLogRepository.js";
import {
  adminResetPassword,
  changeUserRole,
  createUser,
  deactivateUser,
  getUser,
  listUsers,
  reactivateUser,
  reassignUserRegion,
  updateUserProfile,
} from "../services/userManagement/userManagementService.js";
import type { ManagedUser } from "../repositories/userRepository.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";
import {
  changeRoleSchema,
  createUserSchema,
  listUsersQuerySchema,
  passwordResetSchema,
  reassignRegionSchema,
  updateProfileSchema,
  userIdParamSchema,
} from "../validators/adminUserValidators.js";

function parseUserId(params: Record<string, string | undefined>): string {
  const result = userIdParamSchema.safeParse(params);
  if (!result.success) {
    throw badRequest("Invalid user id", result.error.flatten());
  }
  return result.data.id;
}

function recordUserMutation(
  request: Request,
  actor: AuthenticatedUser,
  target: ManagedUser,
  eventType: ActivityEventType,
  extra?: Record<string, unknown>,
): void {
  recordActivity({
    eventType,
    actor: {
      id: actor.id,
      email: actor.email,
      role: actor.role,
    },
    regionId: target.regionId ?? null,
    targetType: "user",
    targetId: target.id,
    metadata: {
      targetEmail: target.email,
      targetUsername: target.username,
      targetRole: target.role,
      ...(extra ?? {}),
    },
    request,
  });
}

export const listAdminUsersController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireCurrentUser(request.currentUser);
    const filters = listUsersQuerySchema.parse(request.query);
    const users = await listUsers({
      ...(filters.role !== undefined ? { role: filters.role } : {}),
      ...(filters.regionId !== undefined ? { regionId: filters.regionId } : {}),
      ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
      ...(filters.q !== undefined ? { search: filters.q } : {}),
    });
    response.json({ data: users });
  },
);

export const getAdminUserController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireCurrentUser(request.currentUser);
    const userId = parseUserId(request.params);
    const user = await getUser(userId);
    response.json({ data: user });
  },
);

export const createAdminUserController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const input = createUserSchema.parse(request.body);
    const user = await createUser({
      email: input.email,
      username: input.username ?? null,
      password: input.password,
      role: input.role,
      regionId: input.regionId ?? null,
      mustChangePassword: input.mustChangePassword ?? true,
      actorId: actor.id,
    });
    recordUserMutation(request, actor, user, "USER_CREATED");
    response.status(201).json({ data: user });
  },
);

export const updateAdminUserProfileController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const userId = parseUserId(request.params);
    const input = updateProfileSchema.parse(request.body);
    const user = await updateUserProfile(userId, {
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.username !== undefined ? { username: input.username } : {}),
      actorId: actor.id,
    });
    recordUserMutation(request, actor, user, "USER_PROFILE_UPDATED", {
      changedFields: Object.keys(input),
    });
    response.json({ data: user });
  },
);

export const changeAdminUserRoleController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const userId = parseUserId(request.params);
    const input = changeRoleSchema.parse(request.body);
    const user = await changeUserRole(userId, {
      role: input.role,
      regionId: input.regionId ?? null,
      actorId: actor.id,
    });
    recordUserMutation(request, actor, user, "USER_ROLE_CHANGED", {
      newRole: user.role,
      newRegionId: user.regionId,
    });
    response.json({ data: user });
  },
);

export const reassignAdminUserRegionController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const userId = parseUserId(request.params);
    const input = reassignRegionSchema.parse(request.body);
    const user = await reassignUserRegion(userId, input.regionId, actor.id);
    recordUserMutation(request, actor, user, "USER_REGION_REASSIGNED", {
      newRegionId: user.regionId,
    });
    response.json({ data: user });
  },
);

export const adminPasswordResetController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const userId = parseUserId(request.params);
    const input = passwordResetSchema.parse(request.body);
    const user = await adminResetPassword(userId, {
      password: input.password,
      requireChange: input.requireChange,
      actorId: actor.id,
    });
    recordUserMutation(request, actor, user, "PASSWORD_RESET", {
      requireChange: input.requireChange,
    });
    response.json({ data: user });
  },
);

export const deactivateAdminUserController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const userId = parseUserId(request.params);
    const user = await deactivateUser(userId, actor.id);
    recordUserMutation(request, actor, user, "USER_DEACTIVATED");
    response.json({ data: user });
  },
);

export const reactivateAdminUserController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const userId = parseUserId(request.params);
    const user = await reactivateUser(userId, actor.id);
    recordUserMutation(request, actor, user, "USER_REACTIVATED");
    response.json({ data: user });
  },
);
