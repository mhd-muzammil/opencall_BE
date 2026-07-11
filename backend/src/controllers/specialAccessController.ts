import type { RequestHandler } from "express";
import {
  SPECIAL_ACCESS_SECTIONS,
  SPECIAL_ACCESS_DATA_SCOPES,
  SPECIAL_ACCESS_PERMISSION_LEVELS,
} from "@opencall/shared";
import {
  getAccessRoles,
  createAccessRole,
  editAccessRole,
  removeAccessRole,
  getSpecialAccessList,
  getSpecialAccess,
  createSpecialAccessLogin,
  editSpecialAccessLogin,
  resetSpecialAccessPassword,
  removeSpecialAccessLogin,
} from "../services/specialAccess/specialAccessService.js";
import { recordActivity } from "../services/audit/activityLogger.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";
import {
  createAccessRoleSchema,
  updateAccessRoleSchema,
  createSpecialAccessSchema,
  updateSpecialAccessSchema,
  resetSpecialAccessPasswordSchema,
  idParamSchema,
} from "../validators/specialAccessValidators.js";

function parseId(params: unknown): string {
  const result = idParamSchema.safeParse(params);
  if (!result.success) {
    throw badRequest("Invalid id", result.error.flatten());
  }
  return result.data.id;
}

// ------------------------------- options -------------------------------

export const getSpecialAccessOptionsController: RequestHandler = asyncHandler(
  async (_request, response) => {
    response.json({
      data: {
        sections: SPECIAL_ACCESS_SECTIONS,
        dataScopes: SPECIAL_ACCESS_DATA_SCOPES,
        permissionLevels: SPECIAL_ACCESS_PERMISSION_LEVELS,
      },
    });
  },
);

// ------------------------------- roles -------------------------------

export const listAccessRolesController: RequestHandler = asyncHandler(
  async (request, response) => {
    const includeInactive = request.query.includeInactive === "true";
    const roles = await getAccessRoles(includeInactive);
    response.json({ data: roles });
  },
);

export const createAccessRoleController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const input = createAccessRoleSchema.parse(request.body);
    const role = await createAccessRole({
      name: input.name,
      description: input.description ?? null,
      defaultSections: input.defaultSections,
      defaultDataScope: input.defaultDataScope,
      defaultPermissionLevel: input.defaultPermissionLevel,
      actorId: actor.id,
    });
    recordActivity({
      eventType: "ACCESS_ROLE_CREATED",
      actor: { id: actor.id, email: actor.email, role: actor.role },
      targetType: "access_role",
      targetId: role.id,
      metadata: { name: role.name },
      request,
    });
    response.status(201).json({ data: role });
  },
);

export const updateAccessRoleController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const id = parseId(request.params);
    const input = updateAccessRoleSchema.parse(request.body);
    const role = await editAccessRole(id, { ...input, actorId: actor.id });
    recordActivity({
      eventType: "ACCESS_ROLE_UPDATED",
      actor: { id: actor.id, email: actor.email, role: actor.role },
      targetType: "access_role",
      targetId: role.id,
      metadata: { name: role.name },
      request,
    });
    response.json({ data: role });
  },
);

export const deleteAccessRoleController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const id = parseId(request.params);
    await removeAccessRole(id);
    recordActivity({
      eventType: "ACCESS_ROLE_DELETED",
      actor: { id: actor.id, email: actor.email, role: actor.role },
      targetType: "access_role",
      targetId: id,
      request,
    });
    response.status(204).send();
  },
);

// --------------------------- special access ---------------------------

export const listSpecialAccessController: RequestHandler = asyncHandler(
  async (_request, response) => {
    const list = await getSpecialAccessList();
    response.json({ data: list });
  },
);

export const getSpecialAccessController: RequestHandler = asyncHandler(
  async (request, response) => {
    const id = parseId(request.params);
    const record = await getSpecialAccess(id);
    response.json({ data: record });
  },
);

export const createSpecialAccessController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const input = createSpecialAccessSchema.parse(request.body);
    const record = await createSpecialAccessLogin({
      username: input.username,
      password: input.password,
      roleId: input.roleId ?? null,
      sections: input.sections,
      allRegions: input.allRegions,
      regions: input.regions,
      dataScope: input.dataScope,
      permissionLevel: input.permissionLevel,
      actorId: actor.id,
    });
    recordActivity({
      eventType: "SPECIAL_ACCESS_CREATED",
      actor: { id: actor.id, email: actor.email, role: actor.role },
      targetType: "special_access",
      targetId: record.id,
      metadata: { username: record.username },
      request,
    });
    response.status(201).json({ data: record });
  },
);

export const updateSpecialAccessController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const id = parseId(request.params);
    const input = updateSpecialAccessSchema.parse(request.body);
    const record = await editSpecialAccessLogin(id, {
      ...input,
      actorId: actor.id,
    });
    recordActivity({
      eventType: "SPECIAL_ACCESS_UPDATED",
      actor: { id: actor.id, email: actor.email, role: actor.role },
      targetType: "special_access",
      targetId: record.id,
      metadata: { username: record.username },
      request,
    });
    response.json({ data: record });
  },
);

export const resetSpecialAccessPasswordController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const id = parseId(request.params);
    const input = resetSpecialAccessPasswordSchema.parse(request.body);
    const record = await resetSpecialAccessPassword(id, input.password, actor.id);
    recordActivity({
      eventType: "SPECIAL_ACCESS_UPDATED",
      actor: { id: actor.id, email: actor.email, role: actor.role },
      targetType: "special_access",
      targetId: record.id,
      metadata: { username: record.username, action: "PASSWORD_RESET" },
      request,
    });
    response.json({ data: record });
  },
);

export const deleteSpecialAccessController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const id = parseId(request.params);
    await removeSpecialAccessLogin(id);
    recordActivity({
      eventType: "SPECIAL_ACCESS_DELETED",
      actor: { id: actor.id, email: actor.email, role: actor.role },
      targetType: "special_access",
      targetId: id,
      request,
    });
    response.status(204).send();
  },
);
