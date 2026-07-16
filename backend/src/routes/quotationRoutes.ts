import { Router } from "express";
import {
  autofillQuotationController,
  createQuotationController,
  getQuotationController,
  listQuotationsController,
} from "../controllers/quotationController.js";
import { requirePrincipal } from "../middlewares/authMiddleware.js";

// Customer quotations. Mounted at /api/v1/quotations.
// requirePrincipal accepts a regular user OR a special-access credential; the controller
// requires the "quotations" section for special-access credentials. Region admins reach
// it too — the sidebar shows the section only to super admins, but the API stays open to
// any authenticated principal that passes the section check.
export const quotationRouter = Router();

quotationRouter.get("/autofill", requirePrincipal, autofillQuotationController);
quotationRouter.get("/", requirePrincipal, listQuotationsController);
quotationRouter.get("/:id", requirePrincipal, getQuotationController);
quotationRouter.post("/", requirePrincipal, createQuotationController);
