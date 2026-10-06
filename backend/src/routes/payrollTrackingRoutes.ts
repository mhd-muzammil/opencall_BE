import { Router } from "express";
import {
  getCasePathController,
  getEngineerDayController,
  getEngineerPathController,
  getLiveEngineersController,
  getRosterController,
  getRosterKmController,
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
// One engineer's trail + total km for a day: /path/engineer/:engineerId?date=YYYY-MM-DD
payrollTrackingRouter.get("/path/engineer/:engineerId", getEngineerPathController);
// One case's trail + total km: /path/case/:caseId
payrollTrackingRouter.get("/path/case/:caseId", getCasePathController);
// One engineer's whole day — route, km, duty time, stops, timeline:
// /day/engineer/:engineerId?date=YYYY-MM-DD
payrollTrackingRouter.get("/day/engineer/:engineerId", getEngineerDayController);
