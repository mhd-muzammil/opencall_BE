import type { Request, RequestHandler, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The KM Report's FIELDEZ table as OpenCall passes it on from Payroll: ROUTE
 * KM's two endpoints pointed at Payroll's fieldez_km ones. These pin what makes
 * them that -- they ask Payroll's FIELDEZ endpoints and never ROUTE KM's, they
 * refuse exactly what /route-km refuses (the same parser), and every answer,
 * the not-configured ones included, carries the `waiting` and `missing` the
 * page reads.
 *
 * Payroll is a stub: fetch is replaced, and the client is pointed at a host
 * that cannot resolve, so nothing here leaves the process.
 */

// The controller reads the engineer register through this; mocked so the
// database settings, and the .env behind them, are never loaded.
vi.mock("../repositories/engineerRepository.js", () => ({
  findEngineerContactByName: vi.fn(),
  listEngineersForDropdown: vi.fn(),
}));

const PAYROLL = "http://payroll.invalid";
const LOGIN = `${PAYROLL}/api/auth/login/`;

interface Asked {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

/** Payroll, answering its login and then every question with `answer`. Returns what it was asked. */
function stubPayroll(answer: unknown, status = 200): Asked[] {
  const asked: Asked[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      asked.push({
        method: init.method ?? "GET",
        url,
        authorization: headers.Authorization,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const login = url === LOGIN;
      const code = login ? 200 : status;
      const body = login ? { access: "jwt-test" } : answer;
      return {
        status: code,
        ok: code >= 200 && code < 300,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }),
  );
  return asked;
}

/**
 * The controllers, loaded afresh: the Payroll client reads its settings once,
 * when it is imported, so each test loads it under the settings it names.
 */
async function controllers(configured: boolean) {
  vi.resetModules();
  vi.stubEnv("PAYROLL_API_URL", configured ? PAYROLL : "");
  vi.stubEnv("PAYROLL_API_USER", configured ? "opencall-test" : "");
  vi.stubEnv("PAYROLL_API_PASSWORD", configured ? "test-only" : "");
  return import("./payrollTrackingController.js");
}

/** What a handler answers with. asyncHandler settles on a later tick, so this waits for it. */
function answer(handler: RequestHandler, request: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const response = { json: resolve } as unknown as Response;
    handler(request as Request, response, (error?: unknown) =>
      reject(error ?? new Error("passed on, not answered")),
    );
  });
}

/** The error a handler passes on to the error handler instead of answering. */
function passedOn(handler: RequestHandler, request: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const response = { json: () => reject(new Error("answered, not passed on")) } as unknown as Response;
    handler(request as Request, response, resolve);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Five past days, for two engineers. from and to differ, so a swap of the two would show. */
function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { from: "2026-09-20", to: "2026-09-24", engineer_ids: [7, 8], ...extra };
}

/** Payroll's answer, cut to the last of those days: one engineer measured, one waiting for the FieldEZ tool. */
const RANGE_ANSWER = {
  configured: true,
  days: ["2026-09-24"],
  engineers: [
    {
      engineer_id: 7,
      days: {
        "2026-09-24": { km: 41.2, points: 4, status: "ready", office: false, final: true, missing: 1 },
      },
    },
    {
      engineer_id: 8,
      days: {
        "2026-09-24": { km: null, points: 3, status: "waiting", office: false, final: false, missing: 0 },
      },
    },
  ],
  pending: 0,
  rechecking: 0,
  waiting: 1,
  measured_now: 0,
};

/** Payroll's answer for one engineer-day, with FIELDEZ's own fields on it. */
const DAY_ANSWER = {
  configured: true,
  engineer_id: 7,
  date: "2026-09-24",
  status: "ready",
  km: 41.2,
  points: [
    { kind: "login", at: "2026-09-24T09:30:00+05:30", latitude: 13.08, longitude: 80.27, case_number: null, office: false },
    {
      kind: "checkin",
      at: "2026-09-24T11:00:00+05:30",
      latitude: 13.09,
      longitude: 79.99,
      case_number: "C-1",
      wo: "WO-000000001",
      office: false,
      resolved_at: "2026-09-24T11:45:00+05:30",
      address: "A road",
      user: "An engineer",
    },
    { kind: "logout", at: "2026-09-24T18:30:00+05:30", latitude: 13.08, longitude: 80.27, case_number: null, office: true },
  ],
  path: [
    [13.08, 80.27],
    [13.09, 79.99],
    [13.08, 80.27],
  ],
  error: "",
  final: true,
  missing: [{ case_number: "C-2", wo: null, reason: "no_wo" }],
  waiting: 0,
};

describe("POST /fieldez-km", () => {
  it("asks Payroll's FIELDEZ km for the period and engineers, and passes its answer on as it is", async () => {
    const { getFieldezKmController } = await controllers(true);
    const asked = stubPayroll(RANGE_ANSWER);

    expect(await answer(getFieldezKmController, { body: body() })).toEqual({ data: RANGE_ANSWER });
    // Logged in as every Payroll call is, then FIELDEZ's endpoint -- never ROUTE KM's.
    expect(asked.map((question) => `${question.method} ${question.url}`)).toEqual([
      `POST ${LOGIN}`,
      `POST ${PAYROLL}/api/fieldez_km/range/`,
    ]);
    expect(asked[1]?.authorization).toBe("Bearer jwt-test");
    expect(asked[1]?.body).toEqual({ engineers: [7, 8], from: "2026-09-20", to: "2026-09-24" });
  });

  it("asks about each engineer once, in the order first given, as /route-km does", async () => {
    const { getFieldezKmController } = await controllers(true);
    const asked = stubPayroll(RANGE_ANSWER);

    await answer(getFieldezKmController, { body: body({ engineer_ids: [9, 7, 9, "7", 8] }) });
    expect(asked[1]?.body).toMatchObject({ engineers: [9, 7, 8] });
  });

  const RANGE_REFUSED = { statusCode: 400, message: expect.stringMatching(/^from and to /) };
  const IDS_REFUSED = { statusCode: 400, message: expect.stringMatching(/^engineer_ids /) };

  it.each<[string, Record<string, unknown>, object]>([
    ["no engineer_ids", { engineer_ids: undefined }, IDS_REFUSED],
    ["an empty list of engineers", { engineer_ids: [] }, IDS_REFUSED],
    ["an id of zero", { engineer_ids: [7, 0] }, IDS_REFUSED],
    ["301 engineers", { engineer_ids: Array.from({ length: 301 }, (_, index) => index + 1) }, IDS_REFUSED],
    ["30 February", { from: "2026-02-30", to: "2026-03-05" }, RANGE_REFUSED],
    ["a period that runs backwards", { from: "2026-09-24", to: "2026-08-25" }, RANGE_REFUSED],
    ["63 days", { from: "2026-01-01", to: "2026-03-04" }, RANGE_REFUSED],
  ])("refuses %s with /route-km's message, and asks Payroll nothing", async (_label, extra, refused) => {
    const { getFieldezKmController } = await controllers(true);
    const asked = stubPayroll(RANGE_ANSWER);

    await expect(passedOn(getFieldezKmController, { body: body(extra) })).resolves.toMatchObject(refused);
    expect(asked).toEqual([]);
  });

  it("passes a Payroll failure on to the error handler, as /route-km does", async () => {
    const { getFieldezKmController } = await controllers(true);
    stubPayroll({ detail: "test" }, 500);

    const error = await passedOn(getFieldezKmController, { body: body() });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("/api/fieldez_km/range/ failed (500)");
  });

  it("says it is not configured, with nothing waiting, before reading the body, as /route-km does", async () => {
    const { getFieldezKmController } = await controllers(false);
    const asked = stubPayroll(RANGE_ANSWER);

    for (const requestBody of [body(), {}]) {
      expect(await answer(getFieldezKmController, { body: requestBody })).toEqual({
        data: { configured: false, days: [], engineers: [], pending: 0, measured_now: 0, waiting: 0 },
      });
    }
    expect(asked).toEqual([]);
  });
});

describe("GET /fieldez-km/day/engineer/:engineerId", () => {
  const day = (engineerId: unknown, date: unknown) => ({ params: { engineerId }, query: { date } });

  it("asks Payroll for that engineer-day and passes its answer on as it is", async () => {
    const { getFieldezKmDayController } = await controllers(true);
    const asked = stubPayroll(DAY_ANSWER);

    expect(await answer(getFieldezKmDayController, day("7", "2026-09-24"))).toEqual({ data: DAY_ANSWER });
    expect(asked.map((question) => `${question.method} ${question.url}`)).toEqual([
      `POST ${LOGIN}`,
      `GET ${PAYROLL}/api/fieldez_km/day/?engineer=7&date=2026-09-24`,
    ]);
    expect(asked[1]?.authorization).toBe("Bearer jwt-test");
  });

  it.each<[string, unknown, unknown, RegExp]>([
    ["an engineerId of zero", "0", "2026-09-24", /^engineerId /],
    ["an engineerId that is not digits", "7a", "2026-09-24", /^engineerId /],
    ["no date", "7", undefined, /^date /],
    ["30 February", "7", "2026-02-30", /^date /],
    ["a date repeated in the query", "7", ["2026-09-24", "2026-09-25"], /^date /],
  ])("refuses %s, as the ROUTE KM day does, and asks Payroll nothing", async (_label, engineerId, date, message) => {
    const { getFieldezKmDayController } = await controllers(true);
    const asked = stubPayroll(DAY_ANSWER);

    await expect(passedOn(getFieldezKmDayController, day(engineerId, date))).resolves.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(message),
    });
    expect(asked).toEqual([]);
  });

  it("refuses a bad request even when Payroll is not configured", async () => {
    const { getFieldezKmDayController } = await controllers(false);
    const asked = stubPayroll(DAY_ANSWER);

    await expect(passedOn(getFieldezKmDayController, day("0", "2026-09-24"))).resolves.toMatchObject({
      statusCode: 400,
    });
    expect(asked).toEqual([]);
  });

  it("says it is not configured, naming the engineer and day asked for, with nothing missing or waiting", async () => {
    const { getFieldezKmDayController } = await controllers(false);
    const asked = stubPayroll(DAY_ANSWER);

    expect(await answer(getFieldezKmDayController, day("7", "2026-09-24"))).toEqual({
      data: {
        configured: false,
        engineer_id: 7,
        date: "2026-09-24",
        status: "pending",
        km: null,
        points: [],
        path: [],
        error: "",
        missing: [],
        waiting: 0,
      },
    });
    expect(asked).toEqual([]);
  });
});
