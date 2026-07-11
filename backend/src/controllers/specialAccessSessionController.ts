import type { Request, RequestHandler } from "express";
import type { SpecialAccessPrincipal } from "../types/auth.js";
import { loadScopedReportForPrincipal } from "../services/specialAccess/specialAccessReportService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { forbidden } from "../utils/httpError.js";

/** Ensures the caller is a special-access principal (not a regular user). */
function requireSpecialAccess(request: Request): SpecialAccessPrincipal {
  if (!request.specialAccess) {
    throw forbidden("This endpoint is only for special-access logins");
  }
  return request.specialAccess;
}

export const getSpecialAccessMeController: RequestHandler = asyncHandler(
  async (request, response) => {
    const principal = requireSpecialAccess(request);
    response.json({ data: principal });
  },
);

export const getSpecialAccessReportController: RequestHandler = asyncHandler(
  async (request, response) => {
    const principal = requireSpecialAccess(request);
    const result = await loadScopedReportForPrincipal(principal);
    response.json({ data: result });
  },
);
