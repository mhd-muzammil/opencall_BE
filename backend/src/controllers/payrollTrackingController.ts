import type { RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  getCasePath,
  getEngineerPath,
  getLiveEngineers,
  isPayrollConfigured,
} from "../services/payroll/payrollClient.js";

/**
 * Read-only proxy for the Payroll live-tracking data. Keeps the Payroll service
 * credentials on the server; the OpenCall web/mobile clients call these OpenCall
 * endpoints instead of hitting Payroll directly.
 */

export const getLiveEngineersController: RequestHandler = asyncHandler(
  async (_request, response) => {
    if (!isPayrollConfigured()) {
      response.json({ data: { configured: false, engineers: [] } });
      return;
    }
    const engineers = await getLiveEngineers();
    response.json({ data: { configured: true, engineers } });
  },
);

export const getEngineerPathController: RequestHandler = asyncHandler(
  async (request, response) => {
    const engineerId = Number(request.params.engineerId);
    const date = typeof request.query.date === "string" ? request.query.date : undefined;
    const path = await getEngineerPath(engineerId, date);
    response.json({ data: path });
  },
);

export const getCasePathController: RequestHandler = asyncHandler(
  async (request, response) => {
    const caseId = Number(request.params.caseId);
    const path = await getCasePath(caseId);
    response.json({ data: path });
  },
);
