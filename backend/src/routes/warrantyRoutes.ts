import { Router } from "express";
import {
  createWarrantyJobController,
  downloadWarrantyJobFileController,
  getWarrantyJobController,
  retryWarrantyJobController,
} from "../controllers/warrantyController.js";
import {
  getClosedCallWarrantyListController,
  runClosedCallWarrantySweepController,
} from "../controllers/closedCallWarrantyController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";
import { uploadWarrantyReportMiddleware } from "../middlewares/warrantyUploadMiddleware.js";

export const warrantyRouter = Router();

// Closed-calls warranty list: the latest report's closed calls + each one's warranty
// status, enqueuing uncached serials (capped ~100/day). Self-contained (server-derived).
warrantyRouter.get(
  "/closed-calls",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  getClosedCallWarrantyListController,
);

// Manual "check now" sweep from the latest report's closed calls — admin only.
warrantyRouter.post(
  "/closed-calls/sweep",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  runClosedCallWarrantySweepController,
);

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
