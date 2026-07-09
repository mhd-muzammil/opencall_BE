import type { RequestHandler } from "express";
import {
  deleteUserRecordLayout,
  findUserRecordLayout,
  upsertUserRecordLayout,
} from "../repositories/userRecordLayoutRepository.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { recordLayoutSchema } from "../validators/recordLayoutValidator.js";

export const getRecordLayoutController: RequestHandler = asyncHandler(
  async (request, response) => {
    const current = requireCurrentUser(request.currentUser);
    const layout = await findUserRecordLayout(current.id);
    response.json({ data: layout });
  },
);

export const putRecordLayoutController: RequestHandler = asyncHandler(
  async (request, response) => {
    const current = requireCurrentUser(request.currentUser);
    const input = recordLayoutSchema.parse(request.body);
    const layout = await upsertUserRecordLayout({
      userId: current.id,
      orderedColumns: input.orderedColumns,
    });
    response.json({ data: layout });
  },
);

export const deleteRecordLayoutController: RequestHandler = asyncHandler(
  async (request, response) => {
    const current = requireCurrentUser(request.currentUser);
    await deleteUserRecordLayout(current.id);
    response.json({ data: { ok: true } });
  },
);
