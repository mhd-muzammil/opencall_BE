import { Router } from "express";
import { getEngineerTargetController } from "../controllers/engineerTargetController.js";
import { getClosedCallDetailController } from "../controllers/closedCallDetailController.js";
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

/**
 * The individual closed calls behind those counts, each with its Segment, Product Name,
 * Work Location and WO OTC CODE. Additive: the count route above is untouched, and the
 * closed set comes from the same shared calculation, so the two can never disagree.
 */
engineerTargetRouter.get(
  "/closed-calls",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  getClosedCallDetailController,
);
