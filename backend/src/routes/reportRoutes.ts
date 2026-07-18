import { Router } from "express";
import {
  getRegionEodStateController,
  getReportProductivityController,
} from "../controllers/eodController.js";
import { generateDailyCallPlanReportController } from "../controllers/reportController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";

export const reportRouter = Router();

reportRouter.post(
  "/daily-call-plan/generate",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  generateDailyCallPlanReportController,
);

// Per-region Final-EOD day boundary for a report date.
reportRouter.get(
  "/:date/eod-state",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  getRegionEodStateController,
);

// Per-region productivity for a report date: frozen snapshot when CLOSED,
// live compute otherwise — both through the same shared function.
reportRouter.get(
  "/:date/productivity",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  getReportProductivityController,
);
