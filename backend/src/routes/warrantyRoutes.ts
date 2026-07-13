import { Router } from "express";
import {
  createWarrantyJobController,
  downloadWarrantyJobFileController,
  getWarrantyJobController,
  retryWarrantyJobController,
} from "../controllers/warrantyController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";
import { uploadWarrantyReportMiddleware } from "../middlewares/warrantyUploadMiddleware.js";

export const warrantyRouter = Router();

warrantyRouter.post(
  "/jobs",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  uploadWarrantyReportMiddleware,
  createWarrantyJobController,
);

warrantyRouter.get(
  "/jobs/:id",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  getWarrantyJobController,
);

warrantyRouter.post(
  "/jobs/:id/retry",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  retryWarrantyJobController,
);

warrantyRouter.get(
  "/jobs/:id/file",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  downloadWarrantyJobFileController,
);
