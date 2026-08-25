import { Router } from "express";
import {
  closeSpecialAccessRegionEodController,
  deleteSpecialAccessRecordLayoutController,
  getSpecialAccessEngineersDropdownController,
  getSpecialAccessEodStateController,
  getSpecialAccessProductivityRangeController,
  getSpecialAccessMeController,
  getSpecialAccessRecordColumnsCatalogController,
  getSpecialAccessRecordLayoutController,
  getSpecialAccessReportController,
  getSpecialAccessReportDatesController,
  getSpecialAccessRtplStatusChangesController,
  getSpecialAccessRtplStatusesDropdownController,
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

// Past days. /report-history is user-only, so a special-access login had no
// history at all and could never revisit — or correct — an earlier day's work.
// These two are the scoped substitute: the days it may open, and (via
// /report?date=) the report for one of them.
specialAccessSessionRouter.get("/report-dates", getSpecialAccessReportDatesController);

// RTPL status activity feed. Mirrors GET /report-rows/rtpl-status-changes, which is
// role-guarded; without it the granted RTPL sections rendered a permanently empty
// feed. Scoped to the credential's regions by ASP code.
specialAccessSessionRouter.get(
  "/rtpl-status-changes",
  getSpecialAccessRtplStatusChangesController,
);

// Work Order Details & Entry reference data. Mirrors the admin dropdown endpoints, which
// are role-guarded and therefore unreachable with a special-access token — without these
// the entry modal opened with an empty Engineer picker and the hard-coded RTPL status list.
specialAccessSessionRouter.get(
  "/engineers/dropdown",
  getSpecialAccessEngineersDropdownController,
);
specialAccessSessionRouter.get(
  "/rtpl-statuses/dropdown",
  getSpecialAccessRtplStatusesDropdownController,
);

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

// Final EOD. Mirrors GET /reports/:date/eod-state and POST /regions/:id/eod/close,
// which are role-guarded and so unreachable with a special-access token. The read is
// filtered to granted regions; the close additionally requires `edit` permission and
// the `productivity` grant (enforced in the service, not here).
specialAccessSessionRouter.get("/eod-state/:date", getSpecialAccessEodStateController);
// Productivity summed over ?from=&to=, filtered to the granted regions. Mirrors
// GET /reports/productivity/range for the date-range filter.
specialAccessSessionRouter.get(
  "/productivity/range",
  getSpecialAccessProductivityRangeController,
);
specialAccessSessionRouter.post(
  "/regions/:regionId/eod/close",
  closeSpecialAccessRegionEodController,
);
