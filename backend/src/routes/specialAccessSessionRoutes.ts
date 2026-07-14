import { Router } from "express";
import {
  deleteSpecialAccessRecordLayoutController,
  getSpecialAccessMeController,
  getSpecialAccessRecordColumnsCatalogController,
  getSpecialAccessRecordLayoutController,
  getSpecialAccessReportController,
  patchSpecialAccessReportRowController,
  putSpecialAccessRecordLayoutController,
} from "../controllers/specialAccessSessionController.js";
import { requirePrincipal } from "../middlewares/authMiddleware.js";

// Operational read endpoints for special-access logins. `requirePrincipal` accepts both
// user and special-access tokens; the controllers reject regular users so these are
// effectively special-access only. Mounted at /api/v1/special-access.
export const specialAccessSessionRouter = Router();

specialAccessSessionRouter.use(requirePrincipal);

specialAccessSessionRouter.get("/me", getSpecialAccessMeController);
specialAccessSessionRouter.get("/report", getSpecialAccessReportController);

// Record Format — the credential's own records-grid column layout. Mirrors the
// user-only /record-layout routes, keyed by special_access.id instead of users.id.
specialAccessSessionRouter.get(
  "/record-layout/catalog",
  getSpecialAccessRecordColumnsCatalogController,
);
specialAccessSessionRouter.get("/record-layout", getSpecialAccessRecordLayoutController);
specialAccessSessionRouter.put("/record-layout", putSpecialAccessRecordLayoutController);
specialAccessSessionRouter.delete(
  "/record-layout",
  deleteSpecialAccessRecordLayoutController,
);

// Records table "Save Entry". Mirrors PATCH /report-rows/:id, but authorised against
// the credential's permission level, granted regions and data scope instead of a role.
specialAccessSessionRouter.patch(
  "/report-rows/:id",
  patchSpecialAccessReportRowController,
);
