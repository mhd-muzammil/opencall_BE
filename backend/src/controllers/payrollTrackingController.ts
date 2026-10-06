import type { RequestHandler } from "express";
import {
  findEngineerContactByName,
  listEngineersForDropdown,
} from "../repositories/engineerRepository.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  getCasePath,
  getEngineerDay,
  getEngineerPath,
  getLiveEngineers,
  getRosterFor,
  isPayrollConfigured,
} from "../services/payroll/payrollClient.js";
import {
  KM_RANGE_CONCURRENCY,
  MAX_KM_RANGE_DAYS,
  daysInKmRange,
  mapLimited,
  sumRosterKm,
  todayIstIso,
} from "../services/payroll/rosterKmRange.js";

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
 * Our register, and how each name is identified to Payroll.
 *
 * Email and phone are what actually resolve a person in Payroll — the same keys
 * the case dispatch sends. Looked up here so the board and the cases can never
 * disagree about who someone is.
 */
async function registerRefs() {
  const engineers = await listEngineersForDropdown(null);
  const refs = await Promise.all(
    engineers.map(async (engineer) => {
      const contact = await findEngineerContactByName(engineer.engineerName);
      return {
        name: engineer.engineerName,
        email: contact?.email ?? null,
        phone: contact?.phone ?? null,
      };
    }),
  );
  return { engineers, refs };
}

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

  const { engineers, refs } = await registerRefs();
  if (engineers.length === 0) {
    response.json({ data: { configured: true, engineers: [] } });
    return;
  }

  const date = typeof request.query.date === "string" ? request.query.date : undefined;
  const rows = await getRosterFor(refs, date);

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

/**
 * Kilometres per engineer over a period: /roster/km?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * For the Engineer Productivity table when it shows a month, bill cycle or
 * range. Payroll only knows distance per day, so this asks it day by day — a few
 * at a time — and adds them up. The register is resolved once, not per day.
 */
export const getRosterKmController: RequestHandler = asyncHandler(async (request, response) => {
  if (!isPayrollConfigured()) {
    response.json({ data: { configured: false, engineers: [] } });
    return;
  }
  const from = typeof request.query.from === "string" ? request.query.from : "";
  const to = typeof request.query.to === "string" ? request.query.to : "";
  const days = daysInKmRange(from, to, todayIstIso());
  if (!days) {
    response.status(400).json({
      error: `from and to must be YYYY-MM-DD, in order, at most ${MAX_KM_RANGE_DAYS} days apart`,
    });
    return;
  }

  const { refs } = await registerRefs();
  if (refs.length === 0 || days.length === 0) {
    response.json({ data: { configured: true, engineers: [] } });
    return;
  }

  const perDay = await mapLimited(days, KM_RANGE_CONCURRENCY, (day) => getRosterFor(refs, day));
  response.json({ data: { configured: true, engineers: sumRosterKm(perDay) } });
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
