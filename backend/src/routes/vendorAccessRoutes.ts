import { Router } from "express";
import {
  assignVendorCasesController,
  createVendorAccessController,
  deleteVendorAccessController,
  getVendorAccessController,
  getVendorAccessOptionsController,
  listVendorAccessController,
  listVendorAssignmentsController,
  resetVendorAccessPasswordController,
  unassignVendorCaseController,
  updateVendorAccessController,
} from "../controllers/vendorAccessController.js";

// Admin management for Vendor Access. Mounted under /api/v1/admin/vendor-access, already
// behind requireAuthenticatedUser + requireRole(["SUPER_ADMIN"]) at the mount point.
export const vendorAccessRouter = Router();

// /options must precede /:id so it is not captured as an id.
vendorAccessRouter.get("/options", getVendorAccessOptionsController);
vendorAccessRouter.get("/", listVendorAccessController);
vendorAccessRouter.post("/", createVendorAccessController);
vendorAccessRouter.get("/:id", getVendorAccessController);
vendorAccessRouter.patch("/:id", updateVendorAccessController);
vendorAccessRouter.post("/:id/password", resetVendorAccessPasswordController);
vendorAccessRouter.delete("/:id", deleteVendorAccessController);

// Case assignments for a vendor.
vendorAccessRouter.get("/:id/assignments", listVendorAssignmentsController);
vendorAccessRouter.post("/:id/assignments", assignVendorCasesController);
vendorAccessRouter.delete(
  "/:id/assignments/:assignmentId",
  unassignVendorCaseController,
);
