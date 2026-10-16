import { Router } from "express";
import {
  autofillDeliveryChallanController,
  createDeliveryChallanController,
  getDeliveryChallanController,
  listChallanBranchesController,
  listDeliveryChallansController,
  updateChallanBranchController,
  updateDeliveryChallanController,
} from "../controllers/deliveryChallanController.js";
import { requirePrincipal } from "../middlewares/authMiddleware.js";

// Delivery Challan (Warranty Replacement). Mounted at /api/v1/delivery-challans.
// requirePrincipal accepts a regular user OR a special-access credential; the controller
// admits a SUPER_ADMIN, or a special-access credential holding the "delivery-challans"
// section, and refuses everyone else (region admins, vendor logins) with 403. Editing a
// branch's letterhead is SUPER_ADMIN only.
//
// /autofill and /branches are declared BEFORE /:id, which would otherwise swallow them.
export const deliveryChallanRouter = Router();

deliveryChallanRouter.get("/autofill", requirePrincipal, autofillDeliveryChallanController);
deliveryChallanRouter.get("/branches", requirePrincipal, listChallanBranchesController);
deliveryChallanRouter.put("/branches/:key", requirePrincipal, updateChallanBranchController);
deliveryChallanRouter.get("/", requirePrincipal, listDeliveryChallansController);
deliveryChallanRouter.get("/:id", requirePrincipal, getDeliveryChallanController);
deliveryChallanRouter.post("/", requirePrincipal, createDeliveryChallanController);
// Correcting a challan that already exists: same body as create, same number.
deliveryChallanRouter.put("/:id", requirePrincipal, updateDeliveryChallanController);
