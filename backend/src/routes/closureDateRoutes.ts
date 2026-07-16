import { Router } from "express";
import {
  getClosureDatesStatusController,
  importClosureDatesController,
} from "../controllers/closureDateController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";
import { closureUploadMiddleware } from "../middlewares/closureUploadMiddleware.js";

// Import + status for the Flex Closure ASP Report closure dates. Mounted at
// /api/v1/closure-dates. Import is SUPER_ADMIN / REGION_ADMIN only, like report uploads.
export const closureDateRouter = Router();

closureDateRouter.get(
  "/status",
  requireAuthenticatedUser,
  getClosureDatesStatusController,
);

closureDateRouter.post(
  "/import",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  closureUploadMiddleware,
  importClosureDatesController,
);
