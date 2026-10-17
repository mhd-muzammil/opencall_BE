import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hourly re-push of the engineers' history days: the week before today,
 * one date at a time, each date's failure its own, nothing ever thrown, and
 * nothing at all when Payroll is not configured -- the guards the two-minute
 * case sync already has. The syncs themselves are mocked; what they send is
 * pinned in scorecardBuilder.test.ts.
 */

const mocks = vi.hoisted(() => ({
  isPayrollConfigured: vi.fn(),
  syncAssignedCasesForDate: vi.fn(),
  syncEngineerScorecardsForDate: vi.fn(),
  syncScorecardDaysForDate: vi.fn(),
}));

vi.mock("./payrollClient.js", () => ({ isPayrollConfigured: mocks.isPayrollConfigured }));
vi.mock("./syncAssignedCases.js", () => ({
  syncAssignedCasesForDate: mocks.syncAssignedCasesForDate,
}));
vi.mock("./syncEngineerScorecards.js", () => ({
  syncEngineerScorecardsForDate: mocks.syncEngineerScorecardsForDate,
  syncScorecardDaysForDate: mocks.syncScorecardDaysForDate,
}));

const WEEK = [
  "2026-10-10",
  "2026-10-11",
  "2026-10-12",
  "2026-10-13",
  "2026-10-14",
  "2026-10-15",
  "2026-10-16",
];

/** The scheduler, loaded afresh so no run or timer carries over from another test. */
async function scheduler() {
  vi.resetModules();
  return import("./payrollSyncScheduler.js");
}

function pushedDay(workingDate: string) {
  return {
    configured: true,
    workingDate,
    engineers: 2,
    payroll: { stored: 1, updated: 1, unmatched: [], rejected: [] },
  };
}

/** What the scheduler printed with console.log / console.error, first argument of each. */
const printed = () => vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
const errors = () => vi.mocked(console.error).mock.calls;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.isPayrollConfigured.mockReturnValue(true);
  mocks.syncAssignedCasesForDate.mockResolvedValue({ message: "nothing assigned" });
  mocks.syncEngineerScorecardsForDate.mockResolvedValue({ message: "no plan" });
  mocks.syncScorecardDaysForDate.mockImplementation(async (date: string) => pushedDay(date));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runScorecardDaysOnce", () => {
  it("re-pushes the seven days before today, oldest first, and says what each did", async () => {
    const { runScorecardDaysOnce } = await scheduler();
    mocks.syncScorecardDaysForDate.mockImplementation(async (date: string) =>
      date === "2026-10-11"
        ? { configured: true, workingDate: date, engineers: 0, message: "Cannot read the productivity view for 2026-10-11: no report" }
        : date === "2026-10-12"
          ? {
              ...pushedDay(date),
              payroll: { stored: 0, updated: 2, unmatched: ["Praveen"], rejected: [{ index: 1, reason: "bad" }] },
            }
          : pushedDay(date),
    );

    await runScorecardDaysOnce("2026-10-17");

    expect(mocks.syncScorecardDaysForDate.mock.calls).toEqual(WEEK.map((date) => [date]));
    const lines = printed();
    expect(lines[0]).toBe("[payroll] scorecard days 2026-10-10: stored=1 updated=1");
    expect(lines[1]).toBe(
      "[payroll] scorecard days 2026-10-11: nothing pushed — Cannot read the productivity view for 2026-10-11: no report",
    );
    expect(lines[2]).toBe(
      "[payroll] scorecard days 2026-10-12: stored=0 updated=2 unmatched=[Praveen] rejected=[#1 bad]",
    );
    expect(mocks.syncAssignedCasesForDate).not.toHaveBeenCalled();
    expect(mocks.syncEngineerScorecardsForDate).not.toHaveBeenCalled();
  });

  it("logs a date that fails, carries on with the rest, and never throws", async () => {
    const { runScorecardDaysOnce } = await scheduler();
    mocks.syncScorecardDaysForDate.mockImplementation(async (date: string) => {
      if (date === "2026-10-13") throw new Error("Payroll API /api/cases/scorecard_days/ failed (404): Not Found");
      return pushedDay(date);
    });

    await expect(runScorecardDaysOnce("2026-10-17")).resolves.toBeUndefined();

    expect(mocks.syncScorecardDaysForDate).toHaveBeenCalledTimes(7);
    expect(errors()).toEqual([
      [
        "[payroll] scorecard days 2026-10-13 failed:",
        "Payroll API /api/cases/scorecard_days/ failed (404): Not Found",
      ],
    ]);
  });

  it("does not start a second run while one is still going", async () => {
    const { runScorecardDaysOnce } = await scheduler();
    let release: () => void = () => undefined;
    mocks.syncScorecardDaysForDate.mockImplementationOnce(
      (date: string) =>
        new Promise((resolve) => {
          release = () => resolve(pushedDay(date));
        }),
    );

    const first = runScorecardDaysOnce("2026-10-17");
    await runScorecardDaysOnce("2026-10-17");
    expect(mocks.syncScorecardDaysForDate).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(mocks.syncScorecardDaysForDate).toHaveBeenCalledTimes(7);

    await runScorecardDaysOnce("2026-10-17");
    expect(mocks.syncScorecardDaysForDate).toHaveBeenCalledTimes(14);
  });
});

describe("startPayrollSyncScheduler", () => {
  it("re-pushes the week 5 min after boot and then every hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T06:30:00Z")); // 12:00 PM IST
    const { startPayrollSyncScheduler } = await scheduler();

    startPayrollSyncScheduler();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    expect(mocks.syncScorecardDaysForDate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.syncScorecardDaysForDate.mock.calls).toEqual(WEEK.map((date) => [date]));

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mocks.syncScorecardDaysForDate).toHaveBeenCalledTimes(14);
    // The two-minute case sync runs as it always has, beside it.
    expect(mocks.syncAssignedCasesForDate).toHaveBeenCalled();
  });

  it("starts nothing when Payroll is not configured", async () => {
    vi.useFakeTimers();
    mocks.isPayrollConfigured.mockReturnValue(false);
    const { startPayrollSyncScheduler } = await scheduler();

    startPayrollSyncScheduler();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(mocks.syncScorecardDaysForDate).not.toHaveBeenCalled();
    expect(mocks.syncAssignedCasesForDate).not.toHaveBeenCalled();
  });
});
