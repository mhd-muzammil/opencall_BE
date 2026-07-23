import { Router } from "express";
import {
  getFlexRawSummaryController,
  listFlexRawRecordsController,
  syncFlexRawDataController,
} from "../controllers/flexRawDataController.js";
import {
  requireAuthenticatedUser,
  requirePrincipal,
} from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";

// Sync + per-ASP/month summary for the Flex RAW data. Mounted at /api/v1/flex-raw.
//
// The summary is readable by any principal (special-access logins see the Closed Calls
// cards too). The sync pulls from the raw-data project's API and is SUPER_ADMIN /
// REGION_ADMIN only, like report uploads and the closure-date import.
export const flexRawDataRouter = Router();

flexRawDataRouter.get("/summary", requirePrincipal, getFlexRawSummaryController);
flexRawDataRouter.get("/records", requirePrincipal, listFlexRawRecordsController);

flexRawDataRouter.post(
  "/sync",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  syncFlexRawDataController,
);
