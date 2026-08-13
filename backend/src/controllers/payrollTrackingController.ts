import type { RequestHandler } from "express";
import { listEngineersForDropdown } from "../repositories/engineerRepository.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  getCasePath,
  getEngineerDay,
  getEngineerPath,
  getLiveEngineers,
  getRoster,
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

/** Loose enough to survive the spelling drift between the two systems. */
function nameKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Every engineer and their state for a day — the board you pick from.
 *
 * The LIST is OpenCall's "Add Engineers" register, not Payroll's staff table:
 * asking Payroll who the engineers are filled the board with office staff and HR,
 * who are never going out on a call. Payroll supplies the duty state, position
 * and kilometres for whichever of those people it can match.
 *
 * An engineer OpenCall knows but Payroll cannot match is still listed, flagged
 * `linked: false` — that is precisely the person whose cases are being skipped,
 * so the board is the right place to notice them rather than a container log.
 */
export const getRosterController: RequestHandler = asyncHandler(async (request, response) => {
  const engineers = await listEngineersForDropdown(null);

  if (!isPayrollConfigured()) {
    response.json({ data: { configured: false, engineers: [] } });
    return;
  }

  const date = typeof request.query.date === "string" ? request.query.date : undefined;
  const payrollRows = await getRoster(date);

  const byExactName = new Map(payrollRows.map((row) => [nameKey(row.engineer_name), row]));
  const matchPayroll = (engineerName: string) => {
    const key = nameKey(engineerName);
    const exact = byExactName.get(key);
    if (exact) return exact;
    // Payroll often carries a trailing initial or surname the register omits
    // ("Praveen" here, "Praveen S" there). Only accept it when exactly one row
    // matches, so real namesakes are never guessed at.
    const prefixed = payrollRows.filter((row) => nameKey(row.engineer_name).startsWith(`${key} `));
    return prefixed.length === 1 ? prefixed[0] : undefined;
  };

  const rows = engineers.map((engineer) => {
    const payroll = matchPayroll(engineer.engineerName);
    if (!payroll) {
      return {
        engineer_id: null,
        engineer_name: engineer.engineerName,
        branch: engineer.regionName ?? null,
        linked: false,
        state: "unlinked" as const,
        on_duty: false,
        duty_started_at: null,
        duty_ended_at: null,
        duty_minutes: 0,
        auto_closed: false,
        distance_km: 0,
        stale: false,
        last_seen_minutes: null,
        latitude: null,
        longitude: null,
        accuracy: null,
        status: "",
        timestamp: null,
        active_case_id: null,
        active_case_number: null,
      };
    }
    // Keep the register's name — that is the one the office uses.
    return { ...payroll, engineer_name: engineer.engineerName, linked: true };
  });

  response.json({ data: { configured: true, engineers: rows } });
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
