import { Router } from "express";
import { updateReportRowController, deleteReportRowController } from "../controllers/reportRowController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";

export const reportRowRouter = Router();

reportRowRouter.patch(
  "/:id",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  updateReportRowController,
);

reportRowRouter.delete(
  "/:id",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  deleteReportRowController,
);
