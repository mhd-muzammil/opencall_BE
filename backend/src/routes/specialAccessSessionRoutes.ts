import { Router } from "express";
import {
  getSpecialAccessMeController,
  getSpecialAccessReportController,
} from "../controllers/specialAccessSessionController.js";
import { requirePrincipal } from "../middlewares/authMiddleware.js";

// Operational read endpoints for special-access logins. `requirePrincipal` accepts both
// user and special-access tokens; the controllers reject regular users so these are
// effectively special-access only. Mounted at /api/v1/special-access.
export const specialAccessSessionRouter = Router();

specialAccessSessionRouter.use(requirePrincipal);

specialAccessSessionRouter.get("/me", getSpecialAccessMeController);
specialAccessSessionRouter.get("/report", getSpecialAccessReportController);
