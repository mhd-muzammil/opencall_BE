import { Router } from "express";
import {
  adminPasswordResetController,
  changeAdminUserRoleController,
  createAdminUserController,
  deactivateAdminUserController,
  getAdminUserController,
  listAdminUsersController,
  reactivateAdminUserController,
  reassignAdminUserRegionController,
  setAdminUserRegionsController,
  setAdminUserSectionsController,
  updateAdminUserProfileController,
} from "../controllers/adminUserController.js";
import { listAdminRegionsController } from "../controllers/adminRegionController.js";
import {
  getMonitoringDashboardController,
  getRegionDrillDownController,
  listAdminActivityController,
} from "../controllers/adminMonitoringController.js";
import {
  getRcaTimelineController,
  listRcaCasesController,
} from "../controllers/adminRcaController.js";
import {
  createAdminEngineerController,
  deactivateAdminEngineerController,
  getEngineersDropdownController,
  listAdminEngineersController,
  reactivateAdminEngineerController,
  updateAdminEngineerController,
} from "../controllers/adminEngineerController.js";
import {
  createAdminRtplStatusController,
  deactivateAdminRtplStatusController,
  deleteAdminRtplStatusController,
  getRtplStatusesDropdownController,
  listAdminRtplStatusesController,
  reactivateAdminRtplStatusController,
  updateAdminRtplStatusController,
} from "../controllers/adminRtplStatusController.js";
import {
  getSpecialAccessLoginHistoryController,
  getSpecialAccessLoginSummaryController,
  getUserLoginHistoryController,
  getUserLoginSummaryController,
} from "../controllers/loginActivityController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";
import { specialAccessRouter } from "./specialAccessRoutes.js";
import { vendorAccessRouter } from "./vendorAccessRoutes.js";

export const adminRouter = Router();

adminRouter.use(requireAuthenticatedUser);

// Special-access management (custom roles + scoped logins) — SUPER_ADMIN only.
adminRouter.use(
  "/special-access",
  requireRole(["SUPER_ADMIN"]),
  specialAccessRouter,
);

// Vendor-access management (scoped vendor logins + case assignment) — SUPER_ADMIN only.
adminRouter.use(
  "/vendor-access",
  requireRole(["SUPER_ADMIN"]),
  vendorAccessRouter,
);

// Login-location monitoring — where users / special-access logins signed in from
// (IP-derived place + history). SUPER_ADMIN only; never exposed to the observed principal.
adminRouter.get(
  "/login-activity/users",
  requireRole(["SUPER_ADMIN"]),
  getUserLoginSummaryController,
);
adminRouter.get(
  "/login-activity/users/:id",
  requireRole(["SUPER_ADMIN"]),
  getUserLoginHistoryController,
);
adminRouter.get(
  "/login-activity/special-access",
  requireRole(["SUPER_ADMIN"]),
  getSpecialAccessLoginSummaryController,
);
adminRouter.get(
  "/login-activity/special-access/:id",
  requireRole(["SUPER_ADMIN"]),
  getSpecialAccessLoginHistoryController,
);

adminRouter.get(
  "/regions",
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  listAdminRegionsController,
);

adminRouter.get(
  "/monitoring/dashboard",
  requireRole(["SUPER_ADMIN"]),
  getMonitoringDashboardController,
);

adminRouter.get(
  "/monitoring/regions/:regionId",
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  getRegionDrillDownController,
);

adminRouter.get(
  "/activity",
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  listAdminActivityController,
);

adminRouter.get(
  "/rca/cases",
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  listRcaCasesController,
);

adminRouter.get(
  "/rca/cases/:ticketId",
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  getRcaTimelineController,
);

adminRouter.get(
  "/engineers/dropdown",
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  getEngineersDropdownController,
);

adminRouter.get(
  "/engineers",
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  listAdminEngineersController,
);

adminRouter.post(
  "/engineers",
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  createAdminEngineerController,
);

adminRouter.patch(
  "/engineers/:id",
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  updateAdminEngineerController,
);

adminRouter.post(
  "/engineers/:id/deactivate",
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  deactivateAdminEngineerController,
);

adminRouter.post(
  "/engineers/:id/reactivate",
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  reactivateAdminEngineerController,
);

// RTPL statuses — dropdown readable by any admin (used in the operational app);
// management (create/update/delete) restricted to SUPER_ADMIN. The list is global.
adminRouter.get(
  "/rtpl-statuses/dropdown",
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  getRtplStatusesDropdownController,
);

adminRouter.get(
  "/rtpl-statuses",
  requireRole(["SUPER_ADMIN"]),
  listAdminRtplStatusesController,
);

adminRouter.post(
  "/rtpl-statuses",
  requireRole(["SUPER_ADMIN"]),
  createAdminRtplStatusController,
);

adminRouter.patch(
  "/rtpl-statuses/:id",
  requireRole(["SUPER_ADMIN"]),
  updateAdminRtplStatusController,
);

adminRouter.post(
  "/rtpl-statuses/:id/deactivate",
  requireRole(["SUPER_ADMIN"]),
  deactivateAdminRtplStatusController,
);

adminRouter.post(
  "/rtpl-statuses/:id/reactivate",
  requireRole(["SUPER_ADMIN"]),
  reactivateAdminRtplStatusController,
);

adminRouter.delete(
  "/rtpl-statuses/:id",
  requireRole(["SUPER_ADMIN"]),
  deleteAdminRtplStatusController,
);

adminRouter.get(
  "/users",
  requireRole(["SUPER_ADMIN"]),
  listAdminUsersController,
);

adminRouter.post(
  "/users",
  requireRole(["SUPER_ADMIN"]),
  createAdminUserController,
);

adminRouter.get(
  "/users/:id",
  requireRole(["SUPER_ADMIN"]),
  getAdminUserController,
);

adminRouter.patch(
  "/users/:id",
  requireRole(["SUPER_ADMIN"]),
  updateAdminUserProfileController,
);

adminRouter.patch(
  "/users/:id/role",
  requireRole(["SUPER_ADMIN"]),
  changeAdminUserRoleController,
);

adminRouter.patch(
  "/users/:id/region",
  requireRole(["SUPER_ADMIN"]),
  reassignAdminUserRegionController,
);

// Replaces the user's additional managed regions (beyond the primary region_id).
adminRouter.put(
  "/users/:id/regions",
  requireRole(["SUPER_ADMIN"]),
  setAdminUserRegionsController,
);

// Sets which operational sections a REGION_ADMIN may see (null = all sections).
adminRouter.put(
  "/users/:id/sections",
  requireRole(["SUPER_ADMIN"]),
  setAdminUserSectionsController,
);

adminRouter.post(
  "/users/:id/password-reset",
  requireRole(["SUPER_ADMIN"]),
  adminPasswordResetController,
);

adminRouter.post(
  "/users/:id/deactivate",
  requireRole(["SUPER_ADMIN"]),
  deactivateAdminUserController,
);

adminRouter.post(
  "/users/:id/reactivate",
  requireRole(["SUPER_ADMIN"]),
  reactivateAdminUserController,
);
