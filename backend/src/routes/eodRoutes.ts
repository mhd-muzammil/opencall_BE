import { Router } from "express";
import {
  closeRegionEodController,
  reopenRegionEodController,
} from "../controllers/eodController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";

export const regionEodRouter = Router();

regionEodRouter.use(requireAuthenticatedUser);

// A REGION_ADMIN may close their OWN region's day (enforced in the service);
// a SUPER_ADMIN may close any region.
regionEodRouter.post(
  "/:regionId/eod/close",
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  closeRegionEodController,
);

// Reopening a mistakenly-closed region-day is SUPER_ADMIN only.
regionEodRouter.post(
  "/:regionId/eod/reopen",
  requireRole(["SUPER_ADMIN"]),
  reopenRegionEodController,
);
