import { Router } from "express";
import { uploadReportsController } from "../controllers/uploadController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";
import { uploadReportsMiddleware } from "../middlewares/uploadMiddleware.js";

export const uploadRouter = Router();

uploadRouter.post(
  "/",
  requireAuthenticatedUser,
  // Region admins upload too; report generation bounds what their upload can
  // affect to their managed regions (allowedRegionAspCodes).
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  uploadReportsMiddleware,
  uploadReportsController,
);
