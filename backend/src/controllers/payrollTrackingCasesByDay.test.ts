import type { Request, RequestHandler, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The KM Report's case counts as OpenCall passes them on from Payroll: how many
 * calls each engineer-day lists and how many were closed that day, asked of
 * Payroll's cases_by_day as /fieldez-km asks of its own. These pin what makes
 * it that -- it asks Payroll's cases_by_day and nothing else, it refuses
 * exactly what /route-km and /fieldez-km refuse (the same parser, in the same
 * words), and the not-configured answer is the empty one the page reads.
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

/** Payroll's answer, cut to the last two of those days: every engineer, every day, zeros included. */
const RANGE_ANSWER = {
  configured: true,
  days: ["2026-09-23", "2026-09-24"],
  engineers: [
    {
      engineer_id: 7,
      days: {
        "2026-09-23": { cases: 4, closed: 1 },
        "2026-09-24": { cases: 2, closed: 2 },
      },
    },
    {
      engineer_id: 8,
      days: {
        "2026-09-23": { cases: 0, closed: 0 },
        "2026-09-24": { cases: 1, closed: 0 },
      },
    },
  ],
};

describe("POST /cases-by-day", () => {
  it("asks Payroll's case counts for the period and engineers, and passes its answer on as it is", async () => {
    const { getCasesByDayController } = await controllers(true);
    const asked = stubPayroll(RANGE_ANSWER);

    expect(await answer(getCasesByDayController, { body: body() })).toEqual({ data: RANGE_ANSWER });
    // Logged in as every Payroll call is, then the case counts -- never one of the km endpoints.
    expect(asked.map((question) => `${question.method} ${question.url}`)).toEqual([
      `POST ${LOGIN}`,
      `POST ${PAYROLL}/api/tracking/cases_by_day/`,
    ]);
    expect(asked[1]?.authorization).toBe("Bearer jwt-test");
    expect(asked[1]?.body).toEqual({ engineers: [7, 8], from: "2026-09-20", to: "2026-09-24" });
  });

  it("asks about each engineer once, in the order first given, as /fieldez-km does", async () => {
    const { getCasesByDayController } = await controllers(true);
    const asked = stubPayroll(RANGE_ANSWER);

    await answer(getCasesByDayController, { body: body({ engineer_ids: [9, 7, 9, "7", 8] }) });
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
  ])("refuses %s with /route-km's message, word for word, and asks Payroll nothing", async (_label, extra, refused) => {
    const { getCasesByDayController, getRouteKmController } = await controllers(true);
    const asked = stubPayroll(RANGE_ANSWER);

    const error = await passedOn(getCasesByDayController, { body: body(extra) });
    expect(error).toMatchObject(refused);
    // The same parser, so the same words -- not merely a message that starts alike.
    const routeKmError = await passedOn(getRouteKmController, { body: body(extra) });
    expect((error as Error).message).toBe((routeKmError as Error).message);
    expect(asked).toEqual([]);
  });

  it("passes a Payroll failure on to the error handler, as /fieldez-km does", async () => {
    const { getCasesByDayController } = await controllers(true);
    stubPayroll({ detail: "test" }, 500);

    const error = await passedOn(getCasesByDayController, { body: body() });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("/api/tracking/cases_by_day/ failed (500)");
  });

  it("says it is not configured, with no days or engineers, before reading the body, as /fieldez-km does", async () => {
    const { getCasesByDayController } = await controllers(false);
    const asked = stubPayroll(RANGE_ANSWER);

    for (const requestBody of [body(), {}]) {
      expect(await answer(getCasesByDayController, { body: requestBody })).toEqual({
        data: { configured: false, days: [], engineers: [] },
      });
    }
    expect(asked).toEqual([]);
  });
});
