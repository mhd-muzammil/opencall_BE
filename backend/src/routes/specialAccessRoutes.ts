import { Router } from "express";
import {
  getSpecialAccessOptionsController,
  listAccessRolesController,
  createAccessRoleController,
  updateAccessRoleController,
  deleteAccessRoleController,
  listSpecialAccessController,
  getSpecialAccessController,
  createSpecialAccessController,
  updateSpecialAccessController,
  resetSpecialAccessPasswordController,
  deleteSpecialAccessController,
} from "../controllers/specialAccessController.js";

// Mounted under /admin/special-access. Authentication + SUPER_ADMIN role are applied
// by the parent admin router at mount time, so these routes only declare the paths.
export const specialAccessRouter = Router();

specialAccessRouter.get("/options", getSpecialAccessOptionsController);

specialAccessRouter.get("/roles", listAccessRolesController);
specialAccessRouter.post("/roles", createAccessRoleController);
specialAccessRouter.patch("/roles/:id", updateAccessRoleController);
specialAccessRouter.delete("/roles/:id", deleteAccessRoleController);

specialAccessRouter.get("/logins", listSpecialAccessController);
specialAccessRouter.post("/logins", createSpecialAccessController);
specialAccessRouter.get("/logins/:id", getSpecialAccessController);
specialAccessRouter.patch("/logins/:id", updateSpecialAccessController);
specialAccessRouter.post(
  "/logins/:id/password",
  resetSpecialAccessPasswordController,
);
specialAccessRouter.delete("/logins/:id", deleteSpecialAccessController);
