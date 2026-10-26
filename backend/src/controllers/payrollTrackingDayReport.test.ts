import type { Request, RequestHandler, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Day Report as OpenCall passes it on from Payroll: Payroll's day_report,
 * asked a day at a time and put back together one row per engineer. These pin
 * that it asks day_report and nothing else, one day per question, that it
 * refuses what /cases-by-day refuses (the same parser, in the same words) and a
 * period longer than 31 days, and that the not-configured answer is the empty
 * one the page reads.
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
const DAY_REPORT = `${PAYROLL}/api/tracking/day_report/`;

interface Asked {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

/** A cell as Payroll answers it, told apart by its km. */
function cell(km: number) {
  return {
    logins: [], logouts: [], on_duty: false, check_ins: [], check_outs: [],
    assigned: null, attended: null, closed: null, waiting_minutes: 0, waits: [],
    gps_off_minutes: 0, gps_offs: [], gps_ons: [], net_off_minutes: 0, net_offs: [], net_ons: [],
    km,
  };
}

/**
 * Payroll, answering its login and then each day_report question for the day
 * it names, with `answerFor(day)`. Returns what it was asked.
 */
function stubPayroll(answerFor: (day: string) => unknown, status = 200): Asked[] {
  const asked: Asked[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      asked.push({ method: init.method ?? "GET", url, body });
      const login = url === LOGIN;
      const code = login ? 200 : status;
      const reply = login ? { access: "jwt-test" } : answerFor(String(body?.from));
      return {
        status: code,
        ok: code >= 200 && code < 300,
        json: async () => reply,
        text: async () => JSON.stringify(reply),
      };
    }),
  );
  return asked;
}

/** Payroll's answer for one day: engineers 7 and 8, km 7.x and 8.x by the day. */
function dayAnswer(day: string, engineerIds = [7, 8]) {
  const date = Number(day.slice(-2));
  return {
    days: [day],
    engineers: engineerIds.map((id) => ({ engineer_id: id, days: { [day]: cell(id + date / 100) } })),
  };
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
    handler(request as Request, response, (error?: unknown) =>
      reject(error ?? new Error("passed on, not answered")),
    );
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

function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { from: "2026-09-22", to: "2026-09-24", engineer_ids: [8, 7], ...extra };
}

describe("POST /day-report", () => {
  it("asks Payroll's day_report one day at a time, and puts the days back together per engineer", async () => {
    const { getDayReportController } = await controllers(true);
    const asked = stubPayroll((day) => dayAnswer(day));

    const result = (await answer(getDayReportController, { body: body() })) as { data: unknown };
    const days = ["2026-09-22", "2026-09-23", "2026-09-24"];
    expect(result.data).toEqual({
      configured: true,
      days,
      engineers: [8, 7].map((id) => ({
        engineer_id: id,
        days: Object.fromEntries(days.map((day) => [day, cell(id + Number(day.slice(-2)) / 100)])),
      })),
    });
    const questions = asked.filter((question) => question.url !== LOGIN);
    // Only day_report, never another Payroll endpoint, and each day asked once, on its own.
    expect(new Set(questions.map((question) => `${question.method} ${question.url}`))).toEqual(
      new Set([`POST ${DAY_REPORT}`]),
    );
    expect(questions.map((question) => question.body).sort((a, b) => String(a?.from).localeCompare(String(b?.from)))).toEqual(
      days.map((day) => ({ engineers: [8, 7], from: day, to: day })),
    );
  });

  it("leaves out an engineer Payroll did not answer for, rather than showing holes", async () => {
    const { getDayReportController } = await controllers(true);
    stubPayroll((day) => dayAnswer(day, day === "2026-09-23" ? [7] : [7, 8]));

    const result = (await answer(getDayReportController, { body: body() })) as {
      data: { engineers: { engineer_id: number }[] };
    };
    expect(result.data.engineers.map((row) => row.engineer_id)).toEqual([7]);
  });

  it("stops at today: a later day is not asked about", async () => {
    const { getDayReportController } = await controllers(true);
    const asked = stubPayroll((day) => dayAnswer(day));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T06:00:00Z"));
    try {
      const result = (await answer(getDayReportController, { body: body() })) as { data: { days: string[] } };
      expect(result.data.days).toEqual(["2026-09-22", "2026-09-23"]);
    } finally {
      vi.useRealTimers();
    }
    expect(asked.filter((question) => question.url === DAY_REPORT)).toHaveLength(2);
  });

  const RANGE_REFUSED = { statusCode: 400, message: expect.stringMatching(/^from and to /) };
  const IDS_REFUSED = { statusCode: 400, message: expect.stringMatching(/^engineer_ids /) };

  it.each<[string, Record<string, unknown>, object]>([
    ["no engineer_ids", { engineer_ids: undefined }, IDS_REFUSED],
    ["an empty list of engineers", { engineer_ids: [] }, IDS_REFUSED],
    ["an id of zero", { engineer_ids: [7, 0] }, IDS_REFUSED],
    ["30 February", { from: "2026-02-30", to: "2026-03-05" }, RANGE_REFUSED],
    ["a period that runs backwards", { from: "2026-09-24", to: "2026-08-25" }, RANGE_REFUSED],
    ["63 days", { from: "2026-01-01", to: "2026-03-04" }, RANGE_REFUSED],
  ])("refuses %s with /cases-by-day's message, word for word, and asks Payroll nothing", async (_label, extra, refused) => {
    const { getDayReportController, getCasesByDayController } = await controllers(true);
    const asked = stubPayroll((day) => dayAnswer(day));

    const error = await passedOn(getDayReportController, { body: body(extra) });
    expect(error).toMatchObject(refused);
    const casesError = await passedOn(getCasesByDayController, { body: body(extra) });
    expect((error as Error).message).toBe((casesError as Error).message);
    expect(asked).toEqual([]);
  });

  it("refuses more than 31 days, and takes 31", async () => {
    const { getDayReportController } = await controllers(true);
    const asked = stubPayroll((day) => dayAnswer(day));

    const error = await passedOn(getDayReportController, { body: body({ from: "2026-08-01", to: "2026-09-01" }) });
    expect(error).toMatchObject({ statusCode: 400, message: "from and to may cover at most 31 days" });
    expect(asked).toEqual([]);

    const result = (await answer(getDayReportController, { body: body({ from: "2026-08-01", to: "2026-08-31" }) })) as {
      data: { days: string[] };
    };
    expect(result.data.days).toHaveLength(31);
  });

  it("passes a Payroll failure on to the error handler", async () => {
    const { getDayReportController } = await controllers(true);
    stubPayroll(() => ({ detail: "test" }), 500);

    const error = await passedOn(getDayReportController, { body: body() });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("/api/tracking/day_report/ failed (500)");
  });

  it("says it is not configured, with no days or engineers, before reading the body", async () => {
    const { getDayReportController } = await controllers(false);
    const asked = stubPayroll((day) => dayAnswer(day));

    for (const requestBody of [body(), {}]) {
      expect(await answer(getDayReportController, { body: requestBody })).toEqual({
        data: { configured: false, days: [], engineers: [] },
      });
    }
    expect(asked).toEqual([]);
  });
});
