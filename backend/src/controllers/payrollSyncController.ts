import type { RequestHandler } from "express";
import { z } from "zod";
import { syncAssignedCasesForDate } from "../services/payroll/syncAssignedCases.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const workingDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * POST /api/v1/reports/:date/payroll-sync
 * Pushes every engineer-assigned case for the working date into the Payroll
 * app (idempotent). Admin-triggered from the Engineer Productivity view; the
 * frontend can call it once per date in the selected filter window.
 */
export const syncAssignedCasesToPayrollController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireCurrentUser(request.currentUser);
    const workingDate = workingDateSchema.parse(request.params.date);

    response.json({ data: await syncAssignedCasesForDate(workingDate) });
  },
);
