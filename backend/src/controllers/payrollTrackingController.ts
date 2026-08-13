import type { RequestHandler } from "express";
import { listEngineersForDropdown } from "../repositories/engineerRepository.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  getCasePath,
  getEngineerDay,
  getEngineerPath,
  getLiveEngineers,
  getRosterFor,
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

/**
 * Every engineer and their state for a day — the board you pick from.
 *
 * The LIST is our Add Engineers register, not Payroll's staff table: asking
 * Payroll who the engineers are filled the board with office staff and HR who
 * were never going out on a call.
 *
 * The MATCHING is Payroll's, not ours. It owns the alias table and the rules
 * that decide where a case goes, so we hand it the register names and it answers
 * per name — including the ones it cannot resolve, which are exactly the people
 * whose cases are being skipped. Doing this matching here instead cost us the
 * duty state of anyone only an alias could resolve.
 */
export const getRosterController: RequestHandler = asyncHandler(async (request, response) => {
  if (!isPayrollConfigured()) {
    response.json({ data: { configured: false, engineers: [] } });
    return;
  }

  const engineers = await listEngineersForDropdown(null);
  const names = engineers.map((engineer) => engineer.engineerName);
  if (names.length === 0) {
    response.json({ data: { configured: true, engineers: [] } });
    return;
  }

  const date = typeof request.query.date === "string" ? request.query.date : undefined;
  const rows = await getRosterFor(names, date);

  // The register's region is a better label than a blank when Payroll has no
  // branch for them, which is every unmatched row.
  const regionByName = new Map(
    engineers.map((engineer) => [engineer.engineerName, engineer.regionName ?? null]),
  );
  response.json({
    data: {
      configured: true,
      engineers: rows.map((row) => ({
        ...row,
        branch: row.branch ?? regionByName.get(row.engineer_name) ?? null,
      })),
    },
  });
});

/** Everything one engineer did on one day — the "what did they actually do" view. */
export const getEngineerDayController: RequestHandler = asyncHandler(
  async (request, response) => {
    const engineerId = Number(request.params.engineerId);
    const date = typeof request.query.date === "string" ? request.query.date : undefined;
    response.json({ data: await getEngineerDay(engineerId, date) });
  },
);

export const getCasePathController: RequestHandler = asyncHandler(
  async (request, response) => {
    const caseId = Number(request.params.caseId);
    const path = await getCasePath(caseId);
    response.json({ data: path });
  },
);
