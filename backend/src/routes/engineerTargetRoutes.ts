import { Router } from "express";
import { getEngineerTargetController } from "../controllers/engineerTargetController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";

/**
 * Engineer Target — read-only progress against the standing close target.
 * Same audience as the Engineer Productivity view it sits beside.
 */
export const engineerTargetRouter = Router();

engineerTargetRouter.get(
  "/",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  getEngineerTargetController,
);
