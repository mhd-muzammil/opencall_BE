import type { RequestHandler } from "express";
import { forbidden } from "../utils/httpError.js";

/** The sidebar key of the Live Tracking section, which holds the KM Report. */
export const LIVE_TRACKING_SECTION = "live-tracking";

/**
 * Who may use the KM Report's km endpoints: whoever the page itself is shown to.
 *
 *   - a SUPER_ADMIN;
 *   - a REGION_ADMIN with no section list (all sections) or one that holds Live Tracking;
 *   - a special-access login granted Live Tracking.
 *
 * Vendor logins never. Runs after `requirePrincipal`, which has resolved exactly one of
 * the three principals. It matters most on POST /route-km and POST /fieldez-km: each
 * call there makes Payroll measure with Ola, which is metered, and store what it found.
 */
export const requireLiveTrackingAccess: RequestHandler = (request, _response, next) => {
  const user = request.currentUser;
  if (user) {
    if (user.role === "SUPER_ADMIN") return next();
    if (user.role === "REGION_ADMIN") {
      const sections = user.accessibleSections;
      if (sections === null || sections.includes(LIVE_TRACKING_SECTION)) return next();
    }
    throw forbidden("Live Tracking is not open to this user");
  }
  if (request.specialAccess) {
    if (request.specialAccess.sections.includes(LIVE_TRACKING_SECTION)) return next();
    throw forbidden("Live Tracking is not granted to this credential");
  }
  if (request.vendorAccess) {
    throw forbidden("Live Tracking is not available to vendor logins");
  }
  throw forbidden("Authentication required");
};
