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
  updateAdminUserProfileController,
} from "../controllers/adminUserController.js";
import { listAdminRegionsController } from "../controllers/adminRegionController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";

export const adminRouter = Router();

adminRouter.use(requireAuthenticatedUser);

adminRouter.get(
  "/regions",
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  listAdminRegionsController,
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
