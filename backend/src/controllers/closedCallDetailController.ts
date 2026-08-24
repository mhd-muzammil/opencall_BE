import type { RequestHandler } from "express";
import { getClosedCallDetails } from "../services/engineerTarget/closedCallDetailService.js";
import {
  findAllowedRegionsForUser,
  requireCurrentUser,
} from "../services/rbac/regionAccessService.js";
import { aspCodesForRegion } from "../services/rbac/regionRowAccess.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { unprocessableEntity } from "../utils/httpError.js";

/**
 * Closed Calls detail for a date range — the individual calls behind the Engineer Target
 * close counts, each with its Segment, Product Name, Work Location and WO OTC CODE.
 *
 * Read-only, and region-scoped exactly like the Engineer Target view it drills into
 * (a REGION_ADMIN sees only their own ASP codes).
 */
export const getClosedCallDetailController: RequestHandler = asyncHandler(
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

    const engineer = String(request.query.engineer ?? "").trim() || null;

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
      data: await getClosedCallDetails({ fromDate, toDate, allowedAspCodes, engineer }),
    });
  },
);
