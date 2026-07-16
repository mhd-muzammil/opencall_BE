import { Router } from "express";
import { saveCustomerFeedbackController } from "../controllers/customerFeedbackController.js";
import { requirePrincipal } from "../middlewares/authMiddleware.js";

// Customer feedback on a closed call. Mounted at /api/v1/customer-feedback.
// requirePrincipal accepts BOTH regular users and special-access credentials; the
// controller rejects a view-only special-access credential.
export const customerFeedbackRouter = Router();

customerFeedbackRouter.post(
  "/",
  requirePrincipal,
  saveCustomerFeedbackController,
);
