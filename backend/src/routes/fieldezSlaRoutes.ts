import { Router } from "express";
import {
  importFieldezSlaController,
  listFieldezSlaController,
} from "../controllers/fieldezSlaController.js";
import {
  requireAuthenticatedUser,
  requirePrincipal,
} from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";

/**
 * FieldEZ's SLA for every open call. Mounted at /api/v1/fieldez-sla.
 *
 * Reading is open to any principal, the same as the report the SLA decorates — a region
 * admin who can see a call can see what was promised about it, and withholding that would
 * leave the Open Call Report showing a blank column with no way to say why.
 *
 * Writing is SUPER_ADMIN / REGION_ADMIN, matching report uploads, because it is the same
 * kind of act: a machine account replacing what every screen then reports as fact. The
 * FieldEZ worker logs in with such an account already.
 */
export const fieldezSlaRouter = Router();

fieldezSlaRouter.get("/", requirePrincipal, listFieldezSlaController);

fieldezSlaRouter.post(
  "/import",
  requireAuthenticatedUser,
  requireRole(["SUPER_ADMIN", "REGION_ADMIN"]),
  importFieldezSlaController,
);
