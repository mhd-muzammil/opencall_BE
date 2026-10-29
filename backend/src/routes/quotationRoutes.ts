import { Router } from "express";
import {
  autofillQuotationController,
  createQuotationController,
  updateQuotationController,
  sendQuotationController,
  setQuotationPaymentController,
  getQuotationController,
  listQuotationsController,
  listQuotationDraftsController,
  approveQuotationDraftController,
  removeQuotationDraftController,
} from "../controllers/quotationController.js";
import { requirePrincipal } from "../middlewares/authMiddleware.js";

// Customer quotations. Mounted at /api/v1/quotations.
// requirePrincipal accepts a regular user OR a special-access credential; the controller
// requires the "quotations" section for special-access credentials. Region admins reach
// it too — the sidebar shows the section only to super admins, but the API stays open to
// any authenticated principal that passes the section check.
export const quotationRouter = Router();

quotationRouter.get("/autofill", requirePrincipal, autofillQuotationController);
// Quotations the report raised, waiting for approval. Declared before /:id, which would
// otherwise read "drafts" as a quotation id.
quotationRouter.get("/drafts", requirePrincipal, listQuotationDraftsController);
// Approving is filling in the amount: same body as create, and it takes the next number.
quotationRouter.post("/drafts/:id/approve", requirePrincipal, approveQuotationDraftController);
quotationRouter.post("/drafts/:id/remove", requirePrincipal, removeQuotationDraftController);
quotationRouter.get("/", requirePrincipal, listQuotationsController);
quotationRouter.get("/:id", requirePrincipal, getQuotationController);
quotationRouter.post("/", requirePrincipal, createQuotationController);
// Correcting a sheet that already exists: same body as create, same running number.
quotationRouter.put("/:id", requirePrincipal, updateQuotationController);
// Mail the sheet to the customer through the region mailbox Customer Emails uses.
quotationRouter.post("/:id/send", requirePrincipal, sendQuotationController);
// What the customer did about it — a person's call, not something read out of a reply.
quotationRouter.patch("/:id/payment", requirePrincipal, setQuotationPaymentController);
