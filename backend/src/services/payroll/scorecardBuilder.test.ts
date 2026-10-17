import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScorecardDaysBackfill } from "./scorecardDays.js";

/**
 * The live scorecard push and the history days are made by one builder, so a
 * day an engineer looks back on reads what their live card read on it. These
 * pin the live push byte for byte -- the exact request body Payroll receives,
 * key order included -- so sharing the builder cannot have changed a single
 * character of it.
 *
 * Payroll is a stub: fetch is replaced, and the client is pointed at a host
 * that cannot resolve, so nothing here leaves the process. OpenCall's own
 * reads are mocked, so the database settings, and the .env behind them, are
 * never loaded.
 */

const mocks = vi.hoisted(() => ({
  getReportProductivity: vi.fn(),
  findEngineerContactByName: vi.fn(),
  getEngineerTargetProgress: vi.fn(),
}));

vi.mock("../productivity/eodService.js", () => ({
  getReportProductivity: mocks.getReportProductivity,
}));
vi.mock("../../repositories/engineerRepository.js", () => ({
  findEngineerContactByName: mocks.findEngineerContactByName,
}));
vi.mock("../engineerTarget/engineerTargetService.js", () => ({
  DAILY_CLOSE_TARGET: 7,
  WORKING_DAYS_PER_MONTH: 25,
  MONTHLY_CLOSE_TARGET: 175,
  getEngineerTargetProgress: mocks.getEngineerTargetProgress,
}));

const PAYROLL = "http://payroll.invalid";
const LOGIN = `${PAYROLL}/api/auth/login/`;
const DATE = "2026-10-16";

interface Asked {
  method: string;
  url: string;
  /** The request body exactly as sent, unparsed. */
  raw: string | undefined;
}

/** Payroll, answering its login and then every question with `answer`. Returns what it was asked. */
function stubPayroll(answer: unknown): Asked[] {
  const asked: Asked[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      asked.push({
        method: init.method ?? "GET",
        url,
        raw: typeof init.body === "string" ? init.body : undefined,
      });
      const body = url === LOGIN ? { access: "jwt-test" } : answer;
      return {
        status: 200,
        ok: true,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }),
  );
  return asked;
}

/**
 * The sync, loaded afresh: the Payroll client reads its settings once, when it
 * is imported. HttpError comes from the same fresh load, so the sync's
 * `instanceof` sees the class these tests throw.
 */
async function load(configured = true) {
  vi.resetModules();
  vi.stubEnv("PAYROLL_API_URL", configured ? PAYROLL : "");
  vi.stubEnv("PAYROLL_API_USER", configured ? "opencall-test" : "");
  vi.stubEnv("PAYROLL_API_PASSWORD", configured ? "test-only" : "");
  const { HttpError } = await import("../../utils/httpError.js");
  const sync = await import("./syncEngineerScorecards.js");
  return { HttpError, sync };
}

/**
 * Two regions' Engineer Productivity for the day. One engineer appears in both
 * (with stray spaces), one only by a different casing, one with a blank name,
 * and one on the plan with nothing done -- every merge rule the push has.
 */
function productivity() {
  return {
    workingDate: DATE,
    regions: [
      {
        regionId: "r-chn",
        regionCode: "CHN",
        regionName: "Chennai",
        source: "LIVE",
        productivity: {
          list: [
            { name: "Arun Kumar", assigned: 5, attended: 4, closed: 3 },
            { name: "  Bala  ", assigned: 2, attended: 2, closed: 1 },
            { name: "   ", assigned: 9, attended: 9, closed: 9 },
            { name: "ARUN KUMAR", assigned: 1, attended: 0, closed: 0 },
          ],
        },
      },
      {
        regionId: "r-cbe",
        regionCode: "CBE",
        regionName: "Coimbatore",
        source: "FROZEN",
        productivity: {
          list: [
            { name: "Arun Kumar ", assigned: 1, attended: 1, closed: 1 },
            { name: "Chitra", assigned: 0, attended: 0, closed: 0 },
          ],
        },
      },
    ],
  };
}

/** The register's contacts: both keys, phone only, none (not one record), email only. */
const CONTACTS: Record<string, { email: string | null; phone: string | null } | null> = {
  "Arun Kumar": { email: "arun@rtpl.test", phone: "9876543210" },
  Bala: { email: null, phone: "9000000001" },
  "ARUN KUMAR": null,
  Chitra: { email: "chitra@rtpl.test", phone: null },
};

/** Cycle closes, with the same engineer under two region codes. */
const TARGET_PROGRESS = {
  rows: [
    { engineer: "Arun Kumar", periodClosed: 20 },
    { engineer: " Arun Kumar ", periodClosed: 2 },
    { engineer: "Chitra", periodClosed: 5 },
  ],
};

/** What the live push sent for this day before the builder was shared, character for character. */
const LIVE_BODY =
  '{"as_of":"2026-10-16","daily_target":7,"monthly_target":175,"rows":[' +
  '{"engineer_name":"Arun Kumar","assigned":6,"attended":5,"closed":4,"month_closed":22,' +
  '"engineer_email":"arun@rtpl.test","engineer_phone":"9876543210"},' +
  '{"engineer_name":"Bala","assigned":2,"attended":2,"closed":1,"month_closed":0,' +
  '"engineer_phone":"9000000001"},' +
  '{"engineer_name":"ARUN KUMAR","assigned":1,"attended":0,"closed":0,"month_closed":0},' +
  '{"engineer_name":"Chitra","assigned":0,"attended":0,"closed":0,"month_closed":5,' +
  '"engineer_email":"chitra@rtpl.test"}]}';

const LIVE_ANSWER = { saved: 3, zeroed: 1, skipped: [{ engineer_name: "ARUN KUMAR", reason: "unmatched" }] };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getReportProductivity.mockResolvedValue(productivity());
  mocks.findEngineerContactByName.mockImplementation(async (name: string) => CONTACTS[name] ?? null);
  mocks.getEngineerTargetProgress.mockResolvedValue(TARGET_PROGRESS);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("live scorecard push (syncEngineerScorecardsForDate)", () => {
  it("sends Payroll exactly the body it always has", async () => {
    const { sync } = await load();
    const asked = stubPayroll(LIVE_ANSWER);

    const result = await sync.syncEngineerScorecardsForDate(DATE);

    expect(asked.map((question) => `${question.method} ${question.url}`)).toEqual([
      `POST ${LOGIN}`,
      `POST ${PAYROLL}/api/cases/scorecards/`,
    ]);
    expect(asked[1]?.raw).toBe(LIVE_BODY);
    expect(result).toStrictEqual({ configured: true, workingDate: DATE, engineers: 4, payroll: LIVE_ANSWER });
  });

  it("reads the day, the target cycle and each engineer's contact as it always has", async () => {
    const { sync } = await load();
    stubPayroll(LIVE_ANSWER);

    await sync.syncEngineerScorecardsForDate(DATE);

    expect(mocks.getReportProductivity.mock.calls).toEqual([[DATE]]);
    expect(mocks.getEngineerTargetProgress.mock.calls).toEqual([
      [{ fromDate: "2026-09-24", toDate: "2026-10-25", allowedAspCodes: null }],
    ]);
    expect(mocks.findEngineerContactByName.mock.calls).toEqual([
      ["Arun Kumar"],
      ["Bala"],
      ["ARUN KUMAR"],
      ["Chitra"],
    ]);
  });

  it("still pushes the day, with no month-to-date, when the target cycle cannot be read", async () => {
    const { sync } = await load();
    const asked = stubPayroll(LIVE_ANSWER);
    mocks.getEngineerTargetProgress.mockRejectedValue(new Error("cycle unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await sync.syncEngineerScorecardsForDate(DATE);

    expect(asked[1]?.raw).toBe(LIVE_BODY.replace('"month_closed":22', '"month_closed":0').replace('"month_closed":5', '"month_closed":0'));
    expect(result.engineers).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("answers the day it cannot read, and sends nothing", async () => {
    const { HttpError, sync } = await load();
    const asked = stubPayroll(LIVE_ANSWER);
    mocks.getReportProductivity.mockRejectedValue(
      new HttpError(422, "No completed report exists for this working date"),
    );

    expect(await sync.syncEngineerScorecardsForDate(DATE)).toStrictEqual({
      configured: true,
      workingDate: DATE,
      engineers: 0,
      message: "Cannot read the productivity view for 2026-10-16: No completed report exists for this working date",
    });
    expect(asked).toEqual([]);
  });

  it("throws a fault that is not about the date, rather than calling it no report", async () => {
    const { sync } = await load();
    const asked = stubPayroll(LIVE_ANSWER);
    mocks.getReportProductivity.mockRejectedValue(new Error("connection terminated"));

    await expect(sync.syncEngineerScorecardsForDate(DATE)).rejects.toThrow("connection terminated");
    expect(asked).toEqual([]);
  });

  it("answers an empty plan without reading the cycle or any contact, and sends nothing", async () => {
    const { sync } = await load();
    const asked = stubPayroll(LIVE_ANSWER);
    mocks.getReportProductivity.mockResolvedValue({
      workingDate: DATE,
      regions: [
        {
          regionId: "r-chn",
          regionCode: "CHN",
          regionName: "Chennai",
          source: "LIVE",
          productivity: { list: [{ name: "  ", assigned: 3, attended: 1, closed: 1 }] },
        },
      ],
    });

    expect(await sync.syncEngineerScorecardsForDate(DATE)).toStrictEqual({
      configured: true,
      workingDate: DATE,
      engineers: 0,
      message: "No engineers on the 2026-10-16 plan.",
    });
    expect(mocks.getEngineerTargetProgress).not.toHaveBeenCalled();
    expect(mocks.findEngineerContactByName).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it("does nothing at all when Payroll is not configured", async () => {
    const { sync } = await load(false);
    const asked = stubPayroll(LIVE_ANSWER);

    expect(await sync.syncEngineerScorecardsForDate(DATE)).toStrictEqual({
      configured: false,
      workingDate: DATE,
      engineers: 0,
      message: "Payroll integration is not configured (set PAYROLL_API_URL/USER/PASSWORD).",
    });
    expect(mocks.getReportProductivity).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });
});

/** The same day as a history push: the live card's numbers and names, the targets on every row. */
const DAYS_ROWS =
  "[" +
  '{"engineer_name":"Arun Kumar","day":"2026-10-16","assigned":6,"attended":5,"closed":4,' +
  '"daily_target":7,"monthly_target":175,"engineer_email":"arun@rtpl.test","engineer_phone":"9876543210"},' +
  '{"engineer_name":"Bala","day":"2026-10-16","assigned":2,"attended":2,"closed":1,' +
  '"daily_target":7,"monthly_target":175,"engineer_phone":"9000000001"},' +
  '{"engineer_name":"ARUN KUMAR","day":"2026-10-16","assigned":1,"attended":0,"closed":0,' +
  '"daily_target":7,"monthly_target":175},' +
  '{"engineer_name":"Chitra","day":"2026-10-16","assigned":0,"attended":0,"closed":0,' +
  '"daily_target":7,"monthly_target":175,"engineer_email":"chitra@rtpl.test"}]';

/**
 * One day's history push: all of that day's rows, and the day named complete,
 * so Payroll zeroes anybody no longer on it.
 */
const daysBody = (date: string) =>
  `{"days":${DAYS_ROWS.replaceAll('"day":"2026-10-16"', `"day":"${date}"`)},"complete_days":["${date}"]}`;

const DAYS_BODY = daysBody("2026-10-16");

const DAYS_ANSWER = { stored: 3, updated: 0, unmatched: ["ARUN KUMAR"], rejected: [] };

describe("history push (syncScorecardDaysForDate)", () => {
  it("sends a past day as history rows, to scorecard_days and nowhere else", async () => {
    const { sync } = await load();
    const asked = stubPayroll(DAYS_ANSWER);

    const result = await sync.syncScorecardDaysForDate(DATE);

    expect(asked.map((question) => `${question.method} ${question.url}`)).toEqual([
      `POST ${LOGIN}`,
      `POST ${PAYROLL}/api/cases/scorecard_days/`,
    ]);
    expect(asked[1]?.raw).toBe(DAYS_BODY);
    expect(result).toStrictEqual({
      configured: true,
      workingDate: DATE,
      engineers: 4,
      payroll: { ...DAYS_ANSWER, zeroed: 0 },
    });
  });

  it("carries exactly the numbers and the engineer the live card sends for the same day", async () => {
    const { sync } = await load();
    const asked = stubPayroll(LIVE_ANSWER);

    await sync.syncEngineerScorecardsForDate(DATE);
    await sync.syncScorecardDaysForDate(DATE);

    const live = JSON.parse(asked[1]?.raw ?? "null") as { rows: Array<Record<string, unknown>> };
    const history = JSON.parse(asked[2]?.raw ?? "null") as { days: Array<Record<string, unknown>> };
    expect(history.days).toHaveLength(live.rows.length);
    live.rows.forEach((row, index) => {
      const { month_closed: _monthClosed, ...sameOnBoth } = row;
      expect(history.days[index]).toStrictEqual({
        ...sameOnBoth,
        day: DATE,
        daily_target: 7,
        monthly_target: 175,
      });
    });
  });

  it("does not read the target cycle: a past day needs no month-to-date", async () => {
    const { sync } = await load();
    stubPayroll(DAYS_ANSWER);

    await sync.syncScorecardDaysForDate(DATE);

    expect(mocks.getEngineerTargetProgress).not.toHaveBeenCalled();
  });

  it("skips a date with no completed report and sends nothing, so nothing is zeroed", async () => {
    const { HttpError, sync } = await load();
    const asked = stubPayroll(DAYS_ANSWER);
    mocks.getReportProductivity.mockRejectedValue(
      new HttpError(422, "No completed report exists for this working date"),
    );

    expect(await sync.syncScorecardDaysForDate(DATE)).toStrictEqual({
      configured: true,
      workingDate: DATE,
      engineers: 0,
      message: "Cannot read the productivity view for 2026-10-16: No completed report exists for this working date",
    });
    expect(asked).toEqual([]);
  });

  it("skips a day with nobody on the plan and sends nothing", async () => {
    const { sync } = await load();
    const asked = stubPayroll(DAYS_ANSWER);
    mocks.getReportProductivity.mockResolvedValue({ workingDate: DATE, regions: [] });

    expect(await sync.syncScorecardDaysForDate(DATE)).toStrictEqual({
      configured: true,
      workingDate: DATE,
      engineers: 0,
      message: "No engineers on the 2026-10-16 plan.",
    });
    expect(asked).toEqual([]);
  });

  it("throws a fault that is not about the date", async () => {
    const { sync } = await load();
    const asked = stubPayroll(DAYS_ANSWER);
    mocks.getReportProductivity.mockRejectedValue(new Error("connection terminated"));

    await expect(sync.syncScorecardDaysForDate(DATE)).rejects.toThrow("connection terminated");
    expect(asked).toEqual([]);
  });

  it("builds the rows and sends nothing on a dry run", async () => {
    const { sync } = await load();
    const asked = stubPayroll(DAYS_ANSWER);

    expect(await sync.syncScorecardDaysForDate(DATE, { dryRun: true })).toStrictEqual({
      configured: true,
      workingDate: DATE,
      engineers: 4,
      message: "Dry run: nothing pushed.",
    });
    expect(asked).toEqual([]);
  });

  it("reads the day on a dry run even when Payroll is not configured", async () => {
    const { sync } = await load(false);
    const asked = stubPayroll(DAYS_ANSWER);

    expect(await sync.syncScorecardDaysForDate(DATE, { dryRun: true })).toMatchObject({
      configured: false,
      engineers: 4,
    });
    expect(asked).toEqual([]);
  });

  it("does nothing at all when Payroll is not configured and it is not a dry run", async () => {
    const { sync } = await load(false);
    const asked = stubPayroll(DAYS_ANSWER);

    expect(await sync.syncScorecardDaysForDate(DATE)).toStrictEqual({
      configured: false,
      workingDate: DATE,
      engineers: 0,
      message: "Payroll integration is not configured (set PAYROLL_API_URL/USER/PASSWORD).",
    });
    expect(mocks.getReportProductivity).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });
});

describe("the backfill, one date at a time through the history push", () => {
  /** 14 and 16 Oct have reports; 15 Oct has none. */
  async function threeDays(dryRun: boolean) {
    const { HttpError, sync } = await load();
    const asked = stubPayroll(DAYS_ANSWER);
    mocks.getReportProductivity.mockImplementation(async (date: string) => {
      if (date === "2026-10-15") {
        throw new HttpError(422, "No completed report exists for this working date");
      }
      return productivity();
    });
    const lines: string[] = [];
    const sleep = vi.fn(async (_ms: number): Promise<void> => undefined);
    const summary = await runScorecardDaysBackfill(
      { from: "2026-10-14", to: "2026-10-16", dryRun },
      { pushDay: sync.syncScorecardDaysForDate, sleep, log: (line) => void lines.push(line) },
    );
    return { asked, lines, sleep, summary };
  }

  it("on a dry run reads every date and sends Payroll nothing at all", async () => {
    const { asked, lines, sleep, summary } = await threeDays(true);

    expect(asked).toEqual([]);
    expect(mocks.getReportProductivity.mock.calls).toEqual([
      ["2026-10-14"],
      ["2026-10-15"],
      ["2026-10-16"],
    ]);
    expect(sleep.mock.calls).toEqual([[1000], [1000]]);
    expect(lines).toEqual([
      "Scorecard days 2026-10-14 to 2026-10-16: 3 date(s) -- DRY RUN, nothing is pushed",
      "2026-10-14  engineers=4  pushed=0  unmatched=?  (dry run)",
      "2026-10-15  skipped: Cannot read the productivity view for 2026-10-15: No completed report exists for this working date",
      "2026-10-16  engineers=4  pushed=0  unmatched=?  (dry run)",
      "Done: 3 date(s), 2 read, 1 skipped, 0 failed; 0 row(s) pushed -- dry run, nothing was pushed",
    ]);
    expect(summary).toStrictEqual({ dates: 3, read: 2, skipped: 1, failed: 0, pushed: 0, unmatched: [] });
  });

  it("for real pushes each read date once, as history, and skips the date with no report", async () => {
    const { asked, lines, summary } = await threeDays(false);

    expect(asked.map((question) => `${question.method} ${question.url}`)).toEqual([
      `POST ${LOGIN}`,
      `POST ${PAYROLL}/api/cases/scorecard_days/`,
      `POST ${PAYROLL}/api/cases/scorecard_days/`,
    ]);
    expect(asked[1]?.raw).toBe(daysBody("2026-10-14"));
    expect(asked[2]?.raw).toBe(daysBody("2026-10-16"));
    expect(lines.slice(1, 4)).toEqual([
      "2026-10-14  engineers=4  pushed=3  unmatched=1 [ARUN KUMAR]",
      "2026-10-15  skipped: Cannot read the productivity view for 2026-10-15: No completed report exists for this working date",
      "2026-10-16  engineers=4  pushed=3  unmatched=1 [ARUN KUMAR]",
    ]);
    expect(summary).toStrictEqual({
      dates: 3,
      read: 2,
      skipped: 1,
      failed: 0,
      pushed: 6,
      unmatched: ["ARUN KUMAR"],
    });
  });
});
