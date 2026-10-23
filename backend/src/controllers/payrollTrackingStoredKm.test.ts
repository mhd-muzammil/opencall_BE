import type { Request, RequestHandler, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The KM Report's three tables as stored, for readers that must not measure:
 * GET /route-km/stored, /fieldez-km/stored and /cases-by-day/stored. These pin
 * what makes them safe to read from OpenCall's MCP -- they ask Payroll only its
 * read endpoints (never route_km's or fieldez_km's POST, which measure with
 * Ola), refuse what /route-km refuses before asking anything, and pass a day
 * nobody has measured on as "not_measured" with no km.
 *
 * Payroll is a stub: fetch is replaced, and the client is pointed at a host
 * that cannot resolve, so nothing here leaves the process.
 */

vi.mock("../repositories/engineerRepository.js", () => ({
  findEngineerContactByName: vi.fn(),
  listEngineersForDropdown: vi.fn(),
}));

const PAYROLL = "http://payroll.invalid";
const LOGIN = `${PAYROLL}/api/auth/login/`;

interface Asked {
  method: string;
  url: string;
  body: unknown;
}

function stubPayroll(answer: unknown, status = 200): Asked[] {
  const asked: Asked[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      asked.push({ method: init.method ?? "GET", url, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
      const login = url === LOGIN;
      const code = login ? 200 : status;
      const body = login ? { access: "jwt-test" } : answer;
      return { status: code, ok: code >= 200 && code < 300, json: async () => body, text: async () => JSON.stringify(body) };
    }),
  );
  return asked;
}

async function controllers(configured: boolean) {
  vi.resetModules();
  vi.stubEnv("PAYROLL_API_URL", configured ? PAYROLL : "");
  vi.stubEnv("PAYROLL_API_USER", configured ? "opencall-test" : "");
  vi.stubEnv("PAYROLL_API_PASSWORD", configured ? "test-only" : "");
  return import("./payrollTrackingController.js");
}

function answer(handler: RequestHandler, request: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const response = { json: resolve } as unknown as Response;
    handler(request as Request, response, (error?: unknown) => reject(error ?? new Error("passed on, not answered")));
  });
}

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

function query(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { from: "2026-09-20", to: "2026-09-24", engineer_ids: "7,8", ...extra };
}

const STORED = {
  configured: true,
  days: ["2026-09-24"],
  engineers: [
    { engineer_id: 7, days: { "2026-09-24": { km: 85.53, status: "ready", points: 4, office: false, final: true, measured_at: "2026-09-25T02:00:00+00:00" } } },
    { engineer_id: 8, days: { "2026-09-24": { km: null, status: "not_measured", points: 0, office: false, final: false, measured_at: null } } },
  ],
};

const COUNTS = { configured: true, days: ["2026-09-24"], engineers: [{ engineer_id: 7, days: { "2026-09-24": { cases: 8, closed: 2, checkins: 3 } } }] };

describe("GET .../stored", () => {
  it.each([
    ["getRouteKmStoredController", "/api/tracking/route_km_stored/"],
    ["getFieldezKmStoredController", "/api/fieldez_km/stored/"],
  ] as const)("%s GETs Payroll's stored read and passes its answer on as it is", async (name, path) => {
    const handlers = await controllers(true);
    const asked = stubPayroll(STORED);

    expect(await answer(handlers[name], { query: query() })).toEqual({ data: STORED });
    expect(asked.map((question) => question.method)).toEqual(["POST", "GET"]);
    const url = new URL(asked[1]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${PAYROLL}${path}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ engineers: "7,8", from: "2026-09-20", to: "2026-09-24" });
    // Never the measuring endpoints.
    expect(asked.some((question) => /route_km\/$|fieldez_km\/range\/$/.test(question.url))).toBe(false);
  });

  it("the case counts come from Payroll's cases_by_day, which only reads", async () => {
    const { getCasesByDayStoredController } = await controllers(true);
    const asked = stubPayroll(COUNTS);

    expect(await answer(getCasesByDayStoredController, { query: query() })).toEqual({ data: COUNTS });
    expect(asked[1]).toMatchObject({ method: "POST", url: `${PAYROLL}/api/tracking/cases_by_day/`, body: { engineers: [7, 8], from: "2026-09-20", to: "2026-09-24" } });
  });

  it("takes the ids as one comma-separated value, each asked about once", async () => {
    const { getRouteKmStoredController } = await controllers(true);
    const asked = stubPayroll(STORED);

    await answer(getRouteKmStoredController, { query: query({ engineer_ids: "9, 7,9,7,8" }) });
    expect(new URL(asked[1]!.url).searchParams.get("engineers")).toBe("9,7,8");
  });

  const RANGE_REFUSED = { statusCode: 400, message: expect.stringMatching(/^from and to /) };
  const IDS_REFUSED = { statusCode: 400, message: expect.stringMatching(/^engineer_ids /) };

  it.each<[string, Record<string, unknown>, object]>([
    ["no engineer_ids", { engineer_ids: undefined }, IDS_REFUSED],
    ["an empty value", { engineer_ids: "" }, IDS_REFUSED],
    ["a non-numeric id", { engineer_ids: "7,x" }, IDS_REFUSED],
    ["an id of zero", { engineer_ids: "7,0" }, IDS_REFUSED],
    ["301 engineers", { engineer_ids: Array.from({ length: 301 }, (_, index) => index + 1).join(",") }, IDS_REFUSED],
    ["30 February", { from: "2026-02-30", to: "2026-03-05" }, RANGE_REFUSED],
    ["a period that runs backwards", { from: "2026-09-24", to: "2026-08-25" }, RANGE_REFUSED],
    ["63 days", { from: "2026-01-01", to: "2026-03-04" }, RANGE_REFUSED],
  ])("refuses %s with /route-km's message, and asks Payroll nothing", async (_label, extra, refused) => {
    const handlers = await controllers(true);
    for (const name of ["getRouteKmStoredController", "getFieldezKmStoredController", "getCasesByDayStoredController"] as const) {
      const asked = stubPayroll(STORED);
      await expect(passedOn(handlers[name], { query: query(extra) })).resolves.toMatchObject(refused);
      expect(asked).toEqual([]);
    }
  });

  it("without Payroll, answers not configured and asks nothing", async () => {
    const handlers = await controllers(false);
    const asked = stubPayroll(STORED);
    for (const name of ["getRouteKmStoredController", "getFieldezKmStoredController", "getCasesByDayStoredController"] as const) {
      expect(await answer(handlers[name], { query: query() })).toEqual({ data: { configured: false, days: [], engineers: [] } });
    }
    expect(asked).toEqual([]);
  });

  it("passes a Payroll failure on to the error handler", async () => {
    const { getRouteKmStoredController } = await controllers(true);
    stubPayroll({ detail: "boom" }, 500);
    await expect(passedOn(getRouteKmStoredController, { query: query() })).resolves.toBeInstanceOf(Error);
  });
});
