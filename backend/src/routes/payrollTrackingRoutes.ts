import { Router } from "express";
import {
  getCasePathController,
  getCasesByDayController,
  getCasesByDayStoredController,
  getEngineerDayController,
  getEngineerPathController,
  getFieldezKmController,
  getFieldezKmDayController,
  getFieldezKmStoredController,
  getLiveEngineersController,
  getRosterController,
  getRosterKmController,
  getRosterKmDaysController,
  getRouteKmController,
  getRouteKmDayController,
  getRouteKmStoredController,
} from "../controllers/payrollTrackingController.js";
import { requireAuthenticatedUser, requirePrincipal } from "../middlewares/authMiddleware.js";
import { requireLiveTrackingAccess } from "../middlewares/liveTrackingAccess.js";

export const payrollTrackingRouter = Router();

// The KM Report's km endpoints: only for whoever the Live Tracking section is shown to
// (requireLiveTrackingAccess). Registered before the router-wide guard below, which they
// would otherwise pass for any signed-in user; requirePrincipal also admits the
// special-access logins the section is granted to. The two POSTs make Payroll measure
// with Ola, which is metered, and store the result; the three GETs only read.
const kmAccess = [requirePrincipal, requireLiveTrackingAccess];
// Road km through each day's Login, Check-ins and Logout, per engineer, for the KM Report (polled until pending is 0):
// POST /route-km {from, to, engineer_ids}
payrollTrackingRouter.post("/route-km", ...kmAccess, getRouteKmController);
// The same route with each Check-in at FieldEZ's Problem Resolution place, for the KM Report's FIELDEZ table
// (polled until pending and waiting are 0): POST /fieldez-km {from, to, engineer_ids}
payrollTrackingRouter.post("/fieldez-km", ...kmAccess, getFieldezKmController);
// The three tables as stored, for readers that must not measure (no Ola, no writes):
// GET /route-km/stored, /fieldez-km/stored and /cases-by-day/stored ?from&to&engineer_ids=1,2,3
payrollTrackingRouter.get("/route-km/stored", ...kmAccess, getRouteKmStoredController);
payrollTrackingRouter.get("/fieldez-km/stored", ...kmAccess, getFieldezKmStoredController);
payrollTrackingRouter.get("/cases-by-day/stored", ...kmAccess, getCasesByDayStoredController);

payrollTrackingRouter.use(requireAuthenticatedUser);

// Latest position of every active engineer (from Payroll).
payrollTrackingRouter.get("/live", getLiveEngineersController);
// Every engineer and their state for a day, including those who have finished:
// /roster?date=YYYY-MM-DD
payrollTrackingRouter.get("/roster", getRosterController);
// Kilometres per engineer summed over a period (Engineer Productivity, ranges):
// /roster/km?from=YYYY-MM-DD&to=YYYY-MM-DD
payrollTrackingRouter.get("/roster/km", getRosterKmController);
// The same, kept per day for the KM Report:
// /roster/km/days?from=YYYY-MM-DD&to=YYYY-MM-DD
payrollTrackingRouter.get("/roster/km/days", getRosterKmDaysController);
// One engineer's trail + total km for a day: /path/engineer/:engineerId?date=YYYY-MM-DD
payrollTrackingRouter.get("/path/engineer/:engineerId", getEngineerPathController);
// One case's trail + total km: /path/case/:caseId
payrollTrackingRouter.get("/path/case/:caseId", getCasePathController);
// One engineer's whole day — route, km, duty time, stops, timeline:
// /day/engineer/:engineerId?date=YYYY-MM-DD
payrollTrackingRouter.get("/day/engineer/:engineerId", getEngineerDayController);
// POST /route-km is registered above, behind the Live Tracking check.
// One engineer-day of it, with its points and route, for the map: /route-km/day/engineer/:engineerId?date=YYYY-MM-DD
payrollTrackingRouter.get("/route-km/day/engineer/:engineerId", getRouteKmDayController);
// POST /fieldez-km is registered above, behind the Live Tracking check.
// One engineer-day of it, with its points, route and left-out check-ins, for the map:
// /fieldez-km/day/engineer/:engineerId?date=YYYY-MM-DD
payrollTrackingRouter.get("/fieldez-km/day/engineer/:engineerId", getFieldezKmDayController);
// Cases per engineer per day, and how many were closed that day, for the line under each km in the KM Report's
// three tables (asked once, not polled): POST /cases-by-day {from, to, engineer_ids}
payrollTrackingRouter.post("/cases-by-day", getCasesByDayController);
