import type { RequestHandler } from "express";
import {
  findEngineerContactByName,
  listEngineersForDropdown,
} from "../repositories/engineerRepository.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";
import {
  getCasePath,
  getEngineerDay,
  getEngineerPath,
  getLiveEngineers,
  getRosterAll,
  getRosterFor,
  getRouteKm,
  getRouteKmDay,
  isPayrollConfigured,
} from "../services/payroll/payrollClient.js";
import { withStaff } from "../services/payroll/rosterStaff.js";
import { kmByDay } from "../services/payroll/rosterKmDays.js";
import {
  KM_RANGE_CONCURRENCY,
  MAX_KM_RANGE_DAYS,
  daysInKmRange,
  mapLimited,
  sumRosterKm,
  todayIstIso,
} from "../services/payroll/rosterKmRange.js";
import { parseRouteKmDayRequest, parseRouteKmRequest } from "../services/payroll/routeKmRequest.js";

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
 *
 * `?include=staff` -- the live tracking board only -- adds Payroll's other
 * staff after the register: the office asked to see everybody on duty there,
 * not only the engineers (12 Oct 2026). Without it the answer is unchanged,
 * which is what Engineer Productivity reads.
 */
export const getRosterController: RequestHandler = asyncHandler(async (request, response) => {
  if (!isPayrollConfigured()) {
    response.json({ data: { configured: false, engineers: [] } });
    return;
  }

  const includeStaff = request.query.include === "staff";
  const { engineers, refs } = await registerRefs();
  if (engineers.length === 0 && !includeStaff) {
    response.json({ data: { configured: true, engineers: [] } });
    return;
  }

  const date = typeof request.query.date === "string" ? request.query.date : undefined;
  // Both asked at once, not one after the other: the board polls every 30s and
  // should not wait for two answers in a row.
  const [register, everyone] = await Promise.all([
    engineers.length > 0 ? getRosterFor(refs, date) : Promise.resolve([]),
    includeStaff
      ? getRosterAll(date).catch((error: unknown) => {
          // The staff are an addition: if Payroll cannot list them, the board
          // still shows the engineers it showed before, rather than nothing.
          console.warn("[payroll] roster: other staff unavailable, engineers only:", error);
          return null;
        })
      : Promise.resolve(null),
  ]);
  const rows = everyone ? withStaff(register, everyone) : register;

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

/**
 * Kilometres per engineer PER DAY over a period, for the KM Report:
 * /roster/km/days?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * The same day-by-day questions /roster/km asks, answered without adding the
 * days together. Its own endpoint rather than a change to /roster/km, which
 * Engineer Productivity reads exactly as it is.
 */
export const getRosterKmDaysController: RequestHandler = asyncHandler(async (request, response) => {
  if (!isPayrollConfigured()) {
    response.json({ data: { configured: false, days: [], engineers: [] } });
    return;
  }
  const from = typeof request.query.from === "string" ? request.query.from : "";
  const to = typeof request.query.to === "string" ? request.query.to : "";
  const days = daysInKmRange(from, to, todayIstIso());
  if (!days) {
    throw badRequest(
      `from and to must be YYYY-MM-DD, in order, at most ${MAX_KM_RANGE_DAYS} days apart`,
    );
  }

  const { engineers, refs } = await registerRefs();
  if (refs.length === 0 || days.length === 0) {
    response.json({ data: { configured: true, days, engineers: [] } });
    return;
  }

  const perDay = await mapLimited(days, KM_RANGE_CONCURRENCY, (day) => getRosterFor(refs, day));
  // The register's region labels a row Payroll has no branch for, as the board does.
  const regionByName = new Map(
    engineers.map((engineer) => [engineer.engineerName, engineer.regionName ?? null]),
  );
  response.json({
    data: { configured: true, days, engineers: kmByDay(days, perDay, regionByName) },
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

/**
 * Road km per engineer per day over a period, for the KM Report's ROUTE KM
 * table: POST /route-km {from, to, engineer_ids}
 *
 * The distance by road through the points each engineer marked on a day -- the
 * Login, each Check-in, the Logout -- as Payroll measures it with Ola. Payroll
 * measures a bounded number of days per call and says how many are still
 * pending, so the page asks again until none are.
 */
export const getRouteKmController: RequestHandler = asyncHandler(async (request, response) => {
  if (!isPayrollConfigured()) {
    response.json({
      data: { configured: false, days: [], engineers: [], pending: 0, measured_now: 0 },
    });
    return;
  }
  const parsed = parseRouteKmRequest(request.body, todayIstIso());
  if (!parsed.ok) {
    throw badRequest(parsed.message);
  }
  response.json({ data: await getRouteKm(parsed.engineerIds, parsed.from, parsed.to) });
});

/**
 * One engineer-day of the ROUTE KM table, with its points and road route, for
 * the map beside it: /route-km/day/engineer/:engineerId?date=YYYY-MM-DD
 *
 * The request is checked before the configuration, unlike its neighbours, so
 * that even the not-configured answer names the engineer and day asked for.
 */
export const getRouteKmDayController: RequestHandler = asyncHandler(
  async (request, response) => {
    const parsed = parseRouteKmDayRequest(request.params.engineerId, request.query.date);
    if (!parsed.ok) {
      throw badRequest(parsed.message);
    }
    if (!isPayrollConfigured()) {
      response.json({
        data: {
          configured: false,
          engineer_id: parsed.engineerId,
          date: parsed.date,
          status: "pending",
          km: null,
          points: [],
          path: [],
          error: "",
        },
      });
      return;
    }
    response.json({ data: await getRouteKmDay(parsed.engineerId, parsed.date) });
  },
);
