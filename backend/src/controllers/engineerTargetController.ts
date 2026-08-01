import type { RequestHandler } from "express";
import { getEngineerTargetProgress } from "../services/engineerTarget/engineerTargetService.js";
import {
  findAllowedRegionsForUser,
  requireCurrentUser,
} from "../services/rbac/regionAccessService.js";
import { aspCodesForRegion } from "../services/rbac/regionRowAccess.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { unprocessableEntity } from "../utils/httpError.js";

/**
 * Engineer Target progress for a date range. Read-only; region-scoped exactly like every
 * other engineer view (a REGION_ADMIN sees only their own ASP codes).
 */
export const getEngineerTargetController: RequestHandler = asyncHandler(
  async (request, response) => {
    const user = requireCurrentUser(request.currentUser);

    const fromDate = String(request.query.from ?? "").trim();
    const toDate = String(request.query.to ?? "").trim();
    if (!fromDate || !toDate) {
      throw unprocessableEntity("from and to are required (YYYY-MM-DD)");
    }
    if (fromDate > toDate) {
      throw unprocessableEntity("from must not be after to", { fromDate, toDate });
    }

    const regions = await findAllowedRegionsForUser(user);
    let allowedAspCodes: Set<string> | null = null;
    if (regions !== null) {
      allowedAspCodes = new Set<string>();
      for (const region of regions) {
        for (const code of aspCodesForRegion(region)) {
          allowedAspCodes.add(code.toUpperCase());
        }
      }
    }

    response.json({
      data: await getEngineerTargetProgress({ fromDate, toDate, allowedAspCodes }),
    });
  },
);
