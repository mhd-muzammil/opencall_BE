import type { RequestHandler } from "express";
import { z } from "zod";
import {
  getSpecialAccessLoginHistory,
  getSpecialAccessLoginSummary,
  getUserLoginHistory,
  getUserLoginSummary,
} from "../services/audit/loginActivityService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";

const idSchema = z.string().uuid();

function parseId(raw: unknown): string {
  const result = idSchema.safeParse(raw);
  if (!result.success) {
    throw badRequest("A valid id is required.");
  }
  return result.data;
}

/** Last login location for every user — powers the admin Users list column. */
export const getUserLoginSummaryController: RequestHandler = asyncHandler(
  async (_request, response) => {
    response.json({ data: await getUserLoginSummary() });
  },
);

/** Recent login-location history for one user. */
export const getUserLoginHistoryController: RequestHandler = asyncHandler(
  async (request, response) => {
    const id = parseId(request.params.id);
    response.json({ data: await getUserLoginHistory(id) });
  },
);

/** Last login location for every special-access login. */
export const getSpecialAccessLoginSummaryController: RequestHandler = asyncHandler(
  async (_request, response) => {
    response.json({ data: await getSpecialAccessLoginSummary() });
  },
);

/** Recent login-location history for one special-access login. */
export const getSpecialAccessLoginHistoryController: RequestHandler = asyncHandler(
  async (request, response) => {
    const id = parseId(request.params.id);
    response.json({ data: await getSpecialAccessLoginHistory(id) });
  },
);
