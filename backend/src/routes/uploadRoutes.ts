import { Router } from "express";
import { uploadReportsController } from "../controllers/uploadController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";
import { uploadReportsMiddleware } from "../middlewares/uploadMiddleware.js";

export const uploadRouter = Router();

uploadRouter.post(
  "/",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN"]),
  uploadReportsMiddleware,
  uploadReportsController,
);
