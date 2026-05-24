import type { RequestHandler } from "express";
import { listRegions } from "../repositories/regionRepository.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const listAdminRegionsController: RequestHandler = asyncHandler(
  async (request, response) => {
    const user = requireCurrentUser(request.currentUser);
    const allRegions = await listRegions();

    if (user.role === "SUPER_ADMIN") {
      response.json({ data: allRegions });
      return;
    }

    const ownRegion = allRegions.filter(
      (region) => region.id === user.regionId,
    );
    response.json({ data: ownRegion });
  },
);
