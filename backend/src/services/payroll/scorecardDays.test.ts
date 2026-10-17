import { describe, expect, it, vi } from "vitest";

import {
  BACKFILL_PAUSE_MS,
  SCORECARD_REPUSH_DAYS,
  datesFromTo,
  parseBackfillArgs,
  runScorecardDaysBackfill,
  scorecardRepushDates,
  type BackfillDeps,
} from "./scorecardDays.js";
import type { ScorecardDaysSyncResult } from "./syncEngineerScorecards.js";

const TODAY = "2026-10-17";

describe("scorecardRepushDates (the hourly re-push)", () => {
  it("is the seven days before today, oldest first, and never today", () => {
    expect(SCORECARD_REPUSH_DAYS).toBe(7);
    expect(scorecardRepushDates(TODAY)).toEqual([
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
    ]);
  });

  it("reaches back across a month end", () => {
    expect(scorecardRepushDates("2026-11-03")).toEqual([
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("reaches back across a year end and a leap day", () => {
    expect(scorecardRepushDates("2027-01-02")[0]).toBe("2026-12-26");
    expect(scorecardRepushDates("2028-03-02")).toContain("2028-02-29");
  });
});

describe("datesFromTo", () => {
  it("is every day from one to the other, inclusive", () => {
    expect(datesFromTo("2026-07-30", "2026-08-02")).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
    expect(datesFromTo("2026-07-25", "2026-07-25")).toEqual(["2026-07-25"]);
  });

  it("covers the whole three months of history in 84 dates", () => {
    const dates = datesFromTo("2026-07-25", "2026-10-16");
    expect(dates).toHaveLength(84);
    expect(new Set(dates).size).toBe(84);
  });
});

describe("parseBackfillArgs", () => {
  it("runs from --from to yesterday when --to is left out", () => {
    expect(parseBackfillArgs(["--from", "2026-07-25"], TODAY)).toEqual({
      ok: true,
      from: "2026-07-25",
      to: "2026-10-16",
      dryRun: false,
    });
  });

  it("reads --to, and --dry-run wherever it stands", () => {
    expect(
      parseBackfillArgs(["--dry-run", "--from", "2026-07-25", "--to", "2026-08-24"], TODAY),
    ).toEqual({ ok: true, from: "2026-07-25", to: "2026-08-24", dryRun: true });
    expect(parseBackfillArgs(["--from", "2026-07-25", "--dry-run"], TODAY)).toMatchObject({
      ok: true,
      dryRun: true,
    });
  });

  it("reads --from=DATE and --to=DATE too", () => {
    expect(parseBackfillArgs(["--from=2026-07-25", "--to=2026-07-31"], TODAY)).toEqual({
      ok: true,
      from: "2026-07-25",
      to: "2026-07-31",
      dryRun: false,
    });
  });

  it("takes a single day, and yesterday as the last", () => {
    expect(parseBackfillArgs(["--from", "2026-10-16", "--to", "2026-10-16"], TODAY)).toMatchObject({
      ok: true,
      from: "2026-10-16",
      to: "2026-10-16",
    });
  });

  it("refuses to start without --from", () => {
    expect(parseBackfillArgs([], TODAY)).toEqual({ ok: false, message: "--from is required" });
    expect(parseBackfillArgs(["--dry-run"], TODAY)).toEqual({ ok: false, message: "--from is required" });
  });

  it("refuses a date that is not a real YYYY-MM-DD day", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "25-07-2026", "2026-7-25", "yesterday", ""]) {
      expect(parseBackfillArgs(["--from", bad], TODAY)).toMatchObject({ ok: false });
    }
    expect(parseBackfillArgs(["--from", "2026-07-25", "--to", "2026-09-31"], TODAY)).toEqual({
      ok: false,
      message: "--to needs a YYYY-MM-DD date, not 2026-09-31",
    });
  });

  it("refuses a flag with its date missing, rather than reading the next flag as one", () => {
    expect(parseBackfillArgs(["--from"], TODAY)).toEqual({
      ok: false,
      message: "--from needs a YYYY-MM-DD date",
    });
    expect(parseBackfillArgs(["--from", "--dry-run"], TODAY)).toEqual({
      ok: false,
      message: "--from needs a YYYY-MM-DD date, not --dry-run",
    });
  });

  it("refuses anything it does not know, so a mistyped flag runs nothing", () => {
    expect(parseBackfillArgs(["--from", "2026-07-25", "--dryrun"], TODAY)).toEqual({
      ok: false,
      message: "Unknown argument: --dryrun",
    });
    expect(parseBackfillArgs(["2026-07-25"], TODAY)).toMatchObject({ ok: false });
  });

  it("refuses today and later: today is the live push's", () => {
    for (const to of [TODAY, "2026-10-18"]) {
      expect(parseBackfillArgs(["--from", "2026-07-25", "--to", to], TODAY)).toEqual({
        ok: false,
        message: "--to must be before today (2026-10-17): today is the live push's",
      });
    }
    expect(parseBackfillArgs(["--from", TODAY], TODAY)).toMatchObject({ ok: false });
  });

  it("refuses --from after --to", () => {
    expect(parseBackfillArgs(["--from", "2026-09-01", "--to", "2026-08-31"], TODAY)).toEqual({
      ok: false,
      message: "--from (2026-09-01) is after --to (2026-08-31)",
    });
  });

  it("refuses a day older than Payroll keeps", () => {
    expect(parseBackfillArgs(["--from", "2025-09-12"], TODAY)).toMatchObject({ ok: true });
    expect(parseBackfillArgs(["--from", "2025-09-11"], TODAY)).toEqual({
      ok: false,
      message: "--from must be 2025-09-12 or later: Payroll keeps no day older than 400 days",
    });
  });
});

/** A pushed date's answer from Payroll. */
function pushed(
  workingDate: string,
  engineers: number,
  unmatched: string[] = [],
  rejected: Array<{ index: number; reason: string }> = [],
): ScorecardDaysSyncResult {
  return {
    configured: true,
    workingDate,
    engineers,
    payroll: { stored: engineers - unmatched.length - rejected.length, updated: 0, unmatched, rejected },
  };
}

function deps(pushDay: BackfillDeps["pushDay"]) {
  const lines: string[] = [];
  const sleep = vi.fn(async (_ms: number): Promise<void> => undefined);
  return { lines, sleep, deps: { pushDay, sleep, log: (line: string) => void lines.push(line) } };
}

describe("runScorecardDaysBackfill", () => {
  it("goes one date at a time, oldest first, a second apart", async () => {
    const order: string[] = [];
    const sleeping: string[] = [];
    const run = deps(async (workingDate) => {
      order.push(workingDate);
      return pushed(workingDate, 2);
    });
    run.sleep.mockImplementation(async () => {
      sleeping.push(`after ${order[order.length - 1]}`);
    });

    await runScorecardDaysBackfill({ from: "2026-07-25", to: "2026-07-28", dryRun: false }, run.deps);

    expect(order).toEqual(["2026-07-25", "2026-07-26", "2026-07-27", "2026-07-28"]);
    expect(BACKFILL_PAUSE_MS).toBe(1000);
    expect(run.sleep.mock.calls).toEqual([[1000], [1000], [1000]]);
    expect(sleeping).toEqual(["after 2026-07-25", "after 2026-07-26", "after 2026-07-27"]);
  });

  it("passes --dry-run on to every date", async () => {
    const pushDay = vi.fn(async (workingDate: string) => ({
      configured: true,
      workingDate,
      engineers: 3,
      message: "Dry run: nothing pushed.",
    }));
    const run = deps(pushDay);

    const summary = await runScorecardDaysBackfill(
      { from: "2026-07-25", to: "2026-07-26", dryRun: true },
      run.deps,
    );

    expect(pushDay.mock.calls).toEqual([
      ["2026-07-25", { dryRun: true }],
      ["2026-07-26", { dryRun: true }],
    ]);
    expect(run.lines).toEqual([
      "Scorecard days 2026-07-25 to 2026-07-26: 2 date(s) -- DRY RUN, nothing is pushed",
      "2026-07-25  engineers=3  pushed=0  unmatched=?  (dry run)",
      "2026-07-26  engineers=3  pushed=0  unmatched=?  (dry run)",
      "Done: 2 date(s), 2 read, 0 skipped, 0 failed; 0 row(s) pushed -- dry run, nothing was pushed",
    ]);
    expect(summary).toStrictEqual({ dates: 2, read: 2, skipped: 0, failed: 0, pushed: 0, unmatched: [] });
  });

  it("prints each date's engineers, rows pushed and who Payroll could not match, and adds them up", async () => {
    const answers: Record<string, ScorecardDaysSyncResult> = {
      "2026-07-25": pushed("2026-07-25", 31, ["Lava kumar V"]),
      "2026-07-26": {
        configured: true,
        workingDate: "2026-07-26",
        engineers: 0,
        message: "Cannot read the productivity view for 2026-07-26: No completed report exists for this working date",
      },
      "2026-07-27": pushed("2026-07-27", 30, ["Lava kumar V", "Praveen"], [{ index: 4, reason: "bad day" }]),
    };
    const run = deps(async (workingDate) => answers[workingDate]!);

    const summary = await runScorecardDaysBackfill(
      { from: "2026-07-25", to: "2026-07-27", dryRun: false },
      run.deps,
    );

    expect(run.lines).toEqual([
      "Scorecard days 2026-07-25 to 2026-07-27: 3 date(s)",
      "2026-07-25  engineers=31  pushed=30  unmatched=1 [Lava kumar V]",
      "2026-07-26  skipped: Cannot read the productivity view for 2026-07-26: No completed report exists for this working date",
      "2026-07-27  engineers=30  pushed=27  unmatched=2 [Lava kumar V, Praveen]  rejected=1 [#4: bad day]",
      "Done: 3 date(s), 2 read, 1 skipped, 0 failed; 57 row(s) pushed; unmatched: Lava kumar V, Praveen",
    ]);
    expect(summary).toStrictEqual({
      dates: 3,
      read: 2,
      skipped: 1,
      failed: 0,
      pushed: 57,
      unmatched: ["Lava kumar V", "Praveen"],
    });
  });

  it("reports a date that fails and carries on with the next", async () => {
    const run = deps(async (workingDate) => {
      if (workingDate === "2026-07-26") throw new Error("Payroll API /api/cases/scorecard_days/ failed (502): bad gateway");
      return pushed(workingDate, 2);
    });

    const summary = await runScorecardDaysBackfill(
      { from: "2026-07-25", to: "2026-07-27", dryRun: false },
      run.deps,
    );

    expect(run.lines[2]).toBe(
      "2026-07-26  FAILED: Payroll API /api/cases/scorecard_days/ failed (502): bad gateway",
    );
    expect(run.lines[3]).toBe("2026-07-27  engineers=2  pushed=2  unmatched=0");
    expect(summary).toMatchObject({ dates: 3, read: 2, failed: 1, pushed: 4 });
  });
});
