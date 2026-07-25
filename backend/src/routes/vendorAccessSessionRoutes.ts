import { Router } from "express";
import {
  getVendorAssignmentsController,
  getVendorEngineersController,
  getVendorMeController,
  getVendorReportController,
  patchVendorReportRowController,
} from "../controllers/vendorAccessSessionController.js";
import { requireVendorAccess } from "../middlewares/authMiddleware.js";

// The vendor portal's own endpoints. Mounted at /api/v1/vendor-access. Every route is
// vendor-only (requireVendorAccess rejects user + special-access tokens), and the report /
// row-edit are further scoped server-side to the vendor's assigned cases.
export const vendorAccessSessionRouter = Router();

vendorAccessSessionRouter.use(requireVendorAccess);

vendorAccessSessionRouter.get("/me", getVendorMeController);
vendorAccessSessionRouter.get("/report", getVendorReportController);
vendorAccessSessionRouter.get("/assignments", getVendorAssignmentsController);
vendorAccessSessionRouter.get("/engineers", getVendorEngineersController);
vendorAccessSessionRouter.patch("/report-rows/:id", patchVendorReportRowController);
