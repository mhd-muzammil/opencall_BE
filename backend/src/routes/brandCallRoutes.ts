import { Router } from "express";
import {
  createAcerCallsController,
  deleteAcerCallController,
  listAcerCallsController,
  listRecentAcerCallsController,
  previewAcerCallsController,
  reopenAcerCallController,
  updateAcerCallController,
} from "../controllers/brandCallController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";

// Calls for brands other than HP (Acer first). Mounted at /api/v1/brand-calls.
// Entering, correcting and deleting calls is SUPER_ADMIN only. Listing them (open and
// closed) and reopening a closed one is for whoever works them: a SUPER_ADMIN, or a
// REGION_ADMIN for their regions' calls. Working them — engineer, Morning/Evening status,
// remarks — happens on their report rows through the usual report-row routes, so
// REGION_ADMINs and special-access logins with edit rights do that exactly as for HP.
export const brandCallRouter = Router();

const superAdminOnly = [requireAuthenticatedUser, requireRole(["SUPER_ADMIN"])];

brandCallRouter.post("/acer/preview", ...superAdminOnly, previewAcerCallsController);
brandCallRouter.post("/acer", ...superAdminOnly, createAcerCallsController);
brandCallRouter.get("/acer/recent", ...superAdminOnly, listRecentAcerCallsController);
const workers = [requireAuthenticatedUser, requireRole(["SUPER_ADMIN", "REGION_ADMIN"])];

brandCallRouter.get("/acer", ...workers, listAcerCallsController);
brandCallRouter.patch("/acer/:id", ...superAdminOnly, updateAcerCallController);
brandCallRouter.delete("/acer/:id", ...superAdminOnly, deleteAcerCallController);
brandCallRouter.post("/acer/:id/reopen", ...workers, reopenAcerCallController);
