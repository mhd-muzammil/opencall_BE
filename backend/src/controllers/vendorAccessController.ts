import type { RequestHandler } from "express";
import {
  VENDOR_ACCESS_SECTIONS,
  VENDOR_ACCESS_PERMISSION_LEVELS,
} from "@opencall/shared";
import type { VendorAccessPermissionLevel } from "@opencall/shared";
import { asyncHandler } from "../utils/asyncHandler.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import { recordActivity } from "../services/audit/activityLogger.js";
import {
  assignCases,
  createVendorLogin,
  editVendorLogin,
  getVendor,
  getVendorList,
  listVendorAssignments,
  removeVendorLogin,
  resetVendorPassword,
  unassignCase,
} from "../services/vendorAccess/vendorAccessService.js";
import {
  assignCasesSchema,
  assignmentIdParamSchema,
  createVendorAccessSchema,
  idParamSchema,
  resetVendorPasswordSchema,
  updateVendorAccessSchema,
} from "../validators/vendorAccessValidators.js";

/** Section + permission option lists for the admin form. */
export const getVendorAccessOptionsController: RequestHandler = asyncHandler(
  async (_request, response) => {
    response.json({
      data: {
        sections: VENDOR_ACCESS_SECTIONS,
        permissionLevels: VENDOR_ACCESS_PERMISSION_LEVELS,
      },
    });
  },
);

export const listVendorAccessController: RequestHandler = asyncHandler(
  async (_request, response) => {
    response.json({ data: await getVendorList() });
  },
);

export const getVendorAccessController: RequestHandler = asyncHandler(
  async (request, response) => {
    const { id } = idParamSchema.parse(request.params);
    response.json({ data: await getVendor(id) });
  },
);

export const createVendorAccessController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const input = createVendorAccessSchema.parse(request.body);
    const vendor = await createVendorLogin({
      username: input.username,
      password: input.password,
      sections: input.sections,
      permissionLevel: input.permissionLevel as VendorAccessPermissionLevel,
      createdBy: actor.id,
    });
    recordActivity({
      eventType: "VENDOR_ACCESS_CREATED",
      actor: { id: actor.id, email: actor.email, role: actor.role },
      targetType: "VENDOR_ACCESS",
      targetId: vendor.id,
      metadata: { username: vendor.username },
      request,
    });
    response.status(201).json({ data: vendor });
  },
);

export const updateVendorAccessController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const { id } = idParamSchema.parse(request.params);
    const input = updateVendorAccessSchema.parse(request.body);
    const vendor = await editVendorLogin(id, {
      ...(input.sections !== undefined ? { sections: input.sections } : {}),
      ...(input.permissionLevel !== undefined
        ? { permissionLevel: input.permissionLevel as VendorAccessPermissionLevel }
        : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      updatedBy: actor.id,
    });
    recordActivity({
      eventType: "VENDOR_ACCESS_UPDATED",
      actor: { id: actor.id, email: actor.email, role: actor.role },
      targetType: "VENDOR_ACCESS",
      targetId: vendor.id,
      request,
    });
    response.json({ data: vendor });
  },
);

export const resetVendorAccessPasswordController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const { id } = idParamSchema.parse(request.params);
    const { password } = resetVendorPasswordSchema.parse(request.body);
    const vendor = await resetVendorPassword(id, password, actor.id);
    recordActivity({
      eventType: "VENDOR_ACCESS_UPDATED",
      actor: { id: actor.id, email: actor.email, role: actor.role },
      targetType: "VENDOR_ACCESS",
      targetId: vendor.id,
      metadata: { action: "PASSWORD_RESET" },
      request,
    });
    response.json({ data: vendor });
  },
);

export const deleteVendorAccessController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const { id } = idParamSchema.parse(request.params);
    await removeVendorLogin(id);
    recordActivity({
      eventType: "VENDOR_ACCESS_DELETED",
      actor: { id: actor.id, email: actor.email, role: actor.role },
      targetType: "VENDOR_ACCESS",
      targetId: id,
      request,
    });
    response.status(204).send();
  },
);

export const listVendorAssignmentsController: RequestHandler = asyncHandler(
  async (request, response) => {
    const { id } = idParamSchema.parse(request.params);
    response.json({ data: await listVendorAssignments(id) });
  },
);

export const assignVendorCasesController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const { id } = idParamSchema.parse(request.params);
    const { cases } = assignCasesSchema.parse(request.body);
    const result = await assignCases(
      id,
      cases.map((c) => ({ ticketId: c.ticketId, caseId: c.caseId ?? null })),
      actor.id,
    );
    recordActivity({
      eventType: "VENDOR_CASE_ASSIGNED",
      actor: { id: actor.id, email: actor.email, role: actor.role },
      targetType: "VENDOR_ACCESS",
      targetId: id,
      metadata: { requested: cases.length, assigned: result.assigned },
      request,
    });
    response.status(201).json({ data: result });
  },
);

export const unassignVendorCaseController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireCurrentUser(request.currentUser);
    const { id, assignmentId } = assignmentIdParamSchema.parse(request.params);
    await unassignCase(id, assignmentId);
    recordActivity({
      eventType: "VENDOR_CASE_UNASSIGNED",
      actor: { id: actor.id, email: actor.email, role: actor.role },
      targetType: "VENDOR_ACCESS",
      targetId: id,
      metadata: { assignmentId },
      request,
    });
    response.status(204).send();
  },
);
