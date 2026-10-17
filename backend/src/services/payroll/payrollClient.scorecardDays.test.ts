import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * pushScorecardDays: the history days go to Payroll's scorecard_days at most
 * 500 to a request, one request after another, logged in and retried exactly
 * as every other Payroll call is, and the answers added up as if there had been
 * one request.
 *
 * Payroll is a stub: fetch is replaced, and the client is pointed at a host
 * that cannot resolve, so nothing here leaves the process.
 */

const PAYROLL = "http://payroll.invalid";
const LOGIN = `${PAYROLL}/api/auth/login/`;
const DAYS_URL = `${PAYROLL}/api/cases/scorecard_days/`;

interface Asked {
  url: string;
  authorization: string | undefined;
  days: Array<{ engineer_name: string }> | undefined;
  complete_days: string[] | undefined;
}

/**
 * Payroll: the login answers a fresh token each time; the n-th scorecard_days
 * request is answered by `answer(n, days)` with the status it returns.
 */
function stubPayroll(
  answer: (request: number, days: unknown[]) => { status: number; body: unknown },
): Asked[] {
  const asked: Asked[] = [];
  let logins = 0;
  let requests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const parsed =
        typeof init.body === "string"
          ? (JSON.parse(init.body) as { days?: []; complete_days?: string[] })
          : {};
      asked.push({
        url,
        authorization: headers.Authorization,
        days: parsed.days,
        complete_days: parsed.complete_days,
      });
      const reply =
        url === LOGIN
          ? { status: 200, body: { access: `jwt-${++logins}` } }
          : answer(requests++, parsed.days ?? []);
      return {
        status: reply.status,
        ok: reply.status >= 200 && reply.status < 300,
        json: async () => reply.body,
        text: async () => JSON.stringify(reply.body),
      };
    }),
  );
  return asked;
}

/** The scorecard_days requests alone, without the logins. */
function sizes(asked: Asked[]): Array<number | undefined> {
  return asked.filter((question) => question.url === DAYS_URL).map((question) => question.days?.length);
}

/** Everything stored, nothing else to say. */
function allStored(_request: number, days: unknown[]) {
  return { status: 200, body: { stored: days.length, updated: 0, unmatched: [], rejected: [] } };
}

/** The client, loaded afresh: it reads its settings once, when it is imported. */
async function client() {
  vi.resetModules();
  vi.stubEnv("PAYROLL_API_URL", PAYROLL);
  vi.stubEnv("PAYROLL_API_USER", "opencall-test");
  vi.stubEnv("PAYROLL_API_PASSWORD", "test-only");
  return import("./payrollClient.js");
}

/** `count` history days, each a different engineer so their order shows. */
function days(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    engineer_name: `E${index}`,
    day: "2026-10-01",
    assigned: 1,
    attended: 1,
    closed: 1,
    daily_target: 7,
    monthly_target: 175,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("pushScorecardDays", () => {
  it("sends at most 500 days a request, in order, after one login", async () => {
    const { SCORECARD_DAYS_CHUNK_SIZE, pushScorecardDays } = await client();
    const asked = stubPayroll(allStored);
    const pushed = days(1201);

    const result = await pushScorecardDays(pushed);

    expect(SCORECARD_DAYS_CHUNK_SIZE).toBe(500);
    expect(asked.map((question) => question.url)).toEqual([LOGIN, DAYS_URL, DAYS_URL, DAYS_URL]);
    expect(sizes(asked)).toEqual([500, 500, 201]);
    expect(asked.slice(1).flatMap((question) => question.days ?? [])).toEqual(pushed);
    expect(asked.slice(1).every((question) => question.authorization === "Bearer jwt-1")).toBe(true);
    expect(result).toStrictEqual({ stored: 1201, updated: 0, unmatched: [], rejected: [], zeroed: 0 });
  });

  it("sends exactly 500 in one request, and the 501st in a second", async () => {
    const { pushScorecardDays } = await client();
    let asked = stubPayroll(allStored);
    await pushScorecardDays(days(500));
    expect(sizes(asked)).toEqual([500]);

    asked = stubPayroll(allStored);
    await pushScorecardDays(days(501));
    expect(sizes(asked)).toEqual([500, 1]);
  });

  it("adds the answers up: one name once, and each rejected day by its place in the whole push", async () => {
    const { pushScorecardDays } = await client();
    const answers = [
      { stored: 498, updated: 0, unmatched: ["E7"], rejected: [{ index: 3, reason: "day is in the future" }] },
      { stored: 400, updated: 99, unmatched: ["E7", "E9"], rejected: [{ index: 0, reason: "day is older than 400 days" }] },
      { stored: 0, updated: 201, unmatched: [], rejected: [] },
    ];
    stubPayroll((request) => ({ status: 200, body: answers[request] }));

    expect(await pushScorecardDays(days(1201))).toStrictEqual({
      stored: 898,
      updated: 300,
      unmatched: ["E7", "E9"],
      rejected: [
        { index: 3, reason: "day is in the future" },
        { index: 500, reason: "day is older than 400 days" },
      ],
      zeroed: 0,
    });
  });

  it("asks Payroll nothing when there is nothing to push", async () => {
    const { pushScorecardDays } = await client();
    const asked = stubPayroll(allStored);

    expect(await pushScorecardDays([])).toStrictEqual({
      stored: 0,
      updated: 0,
      unmatched: [],
      rejected: [],
      zeroed: 0,
    });
    expect(asked).toEqual([]);
  });

  it("says the day is complete when the whole day goes in one request, and adds up what Payroll zeroed", async () => {
    const { pushScorecardDays } = await client();
    const asked = stubPayroll((_request, sent) => ({
      status: 200,
      body: { stored: sent.length, updated: 0, unmatched: [], rejected: [], zeroed: 2 },
    }));

    const result = await pushScorecardDays(days(40), { completeDay: "2026-10-01" });

    const requests = asked.filter((question) => question.url === DAYS_URL);
    expect(requests.map((question) => question.complete_days)).toEqual([["2026-10-01"]]);
    expect(result.zeroed).toBe(2);
  });

  it("never calls a day complete when it is split over two requests", async () => {
    const { pushScorecardDays } = await client();
    const asked = stubPayroll(allStored);

    await pushScorecardDays(days(501), { completeDay: "2026-10-01" });

    const requests = asked.filter((question) => question.url === DAYS_URL);
    expect(requests.map((question) => question.complete_days)).toEqual([undefined, undefined]);
  });

  it("calls nothing complete unless asked to", async () => {
    const { pushScorecardDays } = await client();
    const asked = stubPayroll(allStored);

    await pushScorecardDays(days(3));

    expect(asked.filter((question) => question.url === DAYS_URL)[0]?.complete_days).toBeUndefined();
  });

  it("logs in again once and resends a request Payroll answered 401", async () => {
    const { pushScorecardDays } = await client();
    const asked = stubPayroll((request, sent) =>
      request === 0 ? { status: 401, body: { detail: "token expired" } } : allStored(request, sent),
    );

    expect(await pushScorecardDays(days(3))).toMatchObject({ stored: 3 });
    expect(asked.map((question) => question.url)).toEqual([LOGIN, DAYS_URL, LOGIN, DAYS_URL]);
    expect(asked[3]?.authorization).toBe("Bearer jwt-2");
  });

  it("fails out loud when Payroll refuses a request, after the ones before it", async () => {
    const { pushScorecardDays } = await client();
    const asked = stubPayroll((request, sent) =>
      request === 1 ? { status: 500, body: { detail: "boom" } } : allStored(request, sent),
    );

    await expect(pushScorecardDays(days(600))).rejects.toThrow(
      /Payroll API \/api\/cases\/scorecard_days\/ failed \(500\)/,
    );
    expect(sizes(asked)).toEqual([500, 100]);
  });
});
