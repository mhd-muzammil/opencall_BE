import type { RequestHandler } from "express";
import { DAILY_CALL_PLAN_COLUMNS } from "@opencall/shared";
import {
  deleteUserRecordLayout,
  findLatestFlexRawColumnHeaders,
  findUserRecordLayout,
  upsertUserRecordLayout,
} from "../repositories/userRecordLayoutRepository.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { recordLayoutSchema } from "../validators/recordLayoutValidator.js";

// Full set of columns a user may choose from: the standard report columns plus
// any raw Flex WIP Excel headers not already represented by a standard column.
export const getRecordColumnsCatalogController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireCurrentUser(request.currentUser);
    const standard = [...DAILY_CALL_PLAN_COLUMNS];
    const standardSet = new Set<string>(standard);
    const rawHeaders = await findLatestFlexRawColumnHeaders();
    const extra = rawHeaders.filter((h) => h && !standardSet.has(h));
    response.json({ data: { standard, extra, columns: [...standard, ...extra] } });
  },
);

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
