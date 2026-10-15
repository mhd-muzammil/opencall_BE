import { Router } from "express";
import {
  getCasePathController,
  getEngineerDayController,
  getEngineerPathController,
  getFieldezKmController,
  getFieldezKmDayController,
  getLiveEngineersController,
  getRosterController,
  getRosterKmController,
  getRosterKmDaysController,
  getRouteKmController,
  getRouteKmDayController,
} from "../controllers/payrollTrackingController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";

export const payrollTrackingRouter = Router();

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
// Road km through each day's Login, Check-ins and Logout, per engineer, for the KM Report (polled until pending is 0):
// POST /route-km {from, to, engineer_ids}
payrollTrackingRouter.post("/route-km", getRouteKmController);
// One engineer-day of it, with its points and route, for the map: /route-km/day/engineer/:engineerId?date=YYYY-MM-DD
payrollTrackingRouter.get("/route-km/day/engineer/:engineerId", getRouteKmDayController);
// The same route with each Check-in at FieldEZ's Problem Resolution place, for the KM Report's FIELDEZ table
// (polled until pending and waiting are 0): POST /fieldez-km {from, to, engineer_ids}
payrollTrackingRouter.post("/fieldez-km", getFieldezKmController);
// One engineer-day of it, with its points, route and left-out check-ins, for the map:
// /fieldez-km/day/engineer/:engineerId?date=YYYY-MM-DD
payrollTrackingRouter.get("/fieldez-km/day/engineer/:engineerId", getFieldezKmDayController);
