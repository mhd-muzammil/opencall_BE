import type { RequestHandler } from "express";
import { previewMatches } from "../services/compareService/matchPreviewService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { matchPreviewRequestSchema } from "../validators/matchPreviewRequestValidator.js";
import {
  requireCurrentUser,
  resolveEffectiveRegionId,
} from "../services/rbac/regionAccessService.js";

export const matchPreviewController: RequestHandler = asyncHandler(
  async (request, response) => {
    const currentUser = requireCurrentUser(request.currentUser);
    const input = matchPreviewRequestSchema.parse(request.body);
    const regionId = await resolveEffectiveRegionId(
      currentUser,
      request.header("x-region-id") ?? null,
    );
    const result = await previewMatches({
      ...input,
      currentUser,
      regionId,
    });

    response.status(200).json({
      data: result,
    });
  },
);
