import type { RequestHandler } from "express";
import {
  getClosedCallWarrantyList,
  runDailyClosedCallSweep,
} from "../services/warranty/closedCallWarrantyService.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * The latest report's closed calls + each one's warranty status (self-contained — no
 * client-side report needed). Also enqueues uncached serials, capped ~100/day.
 */
export const getClosedCallWarrantyListController: RequestHandler = asyncHandler(
  async (_request, response) => {
    response.json({ data: await getClosedCallWarrantyList() });
  },
);

/**
 * Manually run the closed-calls warranty sweep now (admin action). Enqueues up to the
 * remaining daily budget of uncached serials from the latest report's closed calls.
 */
export const runClosedCallWarrantySweepController: RequestHandler = asyncHandler(
  async (_request, response) => {
    response.json({ data: await runDailyClosedCallSweep() });
  },
);
