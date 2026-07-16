import { Router } from "express";
import {
  catalogPartsStatusController,
  deleteAllCatalogPartsController,
  importCatalogPartsController,
  listCatalogPartsController,
} from "../controllers/partsCatalogController.js";
import {
  requireAuthenticatedUser,
  requirePrincipal,
} from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";
import { partsUploadMiddleware } from "../middlewares/partsUploadMiddleware.js";

// Parts Catalog. Mounted at /api/v1/parts-catalog.
//   - list / status : any principal (regular user OR a special-access credential granted
//                     the "parts-catalog" section — the controller enforces the grant).
//   - import / delete: SUPER_ADMIN only (write actions).
export const partsCatalogRouter = Router();

partsCatalogRouter.get("/", requirePrincipal, listCatalogPartsController);
partsCatalogRouter.get("/status", requirePrincipal, catalogPartsStatusController);

partsCatalogRouter.post(
  "/import",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN"]),
  partsUploadMiddleware,
  importCatalogPartsController,
);

partsCatalogRouter.delete(
  "/",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN"]),
  deleteAllCatalogPartsController,
);
