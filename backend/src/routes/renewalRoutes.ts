import { Router } from "express";
import {
  getRenewalPipelineController,
  saveRenewalLeadController,
} from "../controllers/renewalController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";

/**
 * AMC / Warranty Renewal Pipeline. Same audience as the warranty views (SUPER_ADMIN +
 * REGION_ADMIN); the service region-scopes what a REGION_ADMIN can see and save.
 */
export const renewalRouter = Router();

renewalRouter.get(
  "/leads",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  getRenewalPipelineController,
);

renewalRouter.put(
  "/leads",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  saveRenewalLeadController,
);
