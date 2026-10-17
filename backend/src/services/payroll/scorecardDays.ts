/**
 * The engineer history's days, pushed to Payroll after the day: which past days
 * the hourly re-push sends again, and the one-off backfill behind
 * scripts/backfillScorecardDays.ts.
 *
 * Kept free of side effects and of the database, so its tests run without
 * either: the backfill script runs the moment it is imported, so its argument
 * parsing and its loop live here, where a test can reach them. Each date's rows
 * are built and pushed by syncScorecardDaysForDate, passed in.
 */
import type { ScorecardDaysSyncResult } from "./syncEngineerScorecards.js";

/**
 * How many days before today the hourly re-push sends again. A finished day
 * still changes after the live push has moved on to the next -- an Evening
 * status edited late, a Final EOD freezing the day -- and a week covers that.
 */
export const SCORECARD_REPUSH_DAYS = 7;

/** The backfill's pause between one date and the next. */
export const BACKFILL_PAUSE_MS = 1000;

/** Payroll refuses a day older than this, so the backfill does not ask for one. */
export const BACKFILL_MAX_AGE_DAYS = 400;

export const BACKFILL_USAGE =
  "Usage: node dist/scripts/backfillScorecardDays.js --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run]";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A real calendar day written YYYY-MM-DD: 2026-02-30 is not one. */
function isIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/**
 * The days the hourly re-push sends again: the SCORECARD_REPUSH_DAYS before
 * `today`, oldest first. Never today itself, which is the live push's.
 */
export function scorecardRepushDates(today: string): string[] {
  const dates: string[] = [];
  for (let back = SCORECARD_REPUSH_DAYS; back >= 1; back -= 1) {
    dates.push(addDays(today, -back));
  }
  return dates;
}

/** Every day from `from` to `to` inclusive, oldest first. */
export function datesFromTo(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    dates.push(day);
  }
  return dates;
}

export interface BackfillArgs {
  from: string;
  to: string;
  dryRun: boolean;
}

/**
 * The backfill's command line: --from (required), --to (yesterday when left
 * out) and --dry-run. "--from 2026-07-25" and "--from=2026-07-25" both read.
 *
 * Refused, with the reason, when a date is not a real one, --from is after
 * --to, --to is today or later (today is the live push's), --from is older
 * than Payroll keeps, or anything else is on the line: a mistyped flag must
 * not start a backfill nobody asked for.
 */
export function parseBackfillArgs(
  argv: readonly string[],
  today: string,
): ({ ok: true } & BackfillArgs) | { ok: false; message: string } {
  let from: string | null = null;
  let to: string | null = null;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    const flag = /^--(from|to)(?:=(.*))?$/.exec(arg);
    if (!flag) {
      return { ok: false, message: `Unknown argument: ${arg}` };
    }
    const value = flag[2] ?? argv[++index];
    if (value === undefined || !isIsoDay(value)) {
      return {
        ok: false,
        message: `--${flag[1]} needs a YYYY-MM-DD date${value === undefined ? "" : `, not ${value}`}`,
      };
    }
    if (flag[1] === "from") from = value;
    else to = value;
  }

  if (from === null) {
    return { ok: false, message: "--from is required" };
  }
  const last = to ?? addDays(today, -1);
  if (last >= today) {
    return {
      ok: false,
      message: `--to must be before today (${today}): today is the live push's`,
    };
  }
  if (from > last) {
    return { ok: false, message: `--from (${from}) is after --to (${last})` };
  }
  const oldest = addDays(today, -BACKFILL_MAX_AGE_DAYS);
  if (from < oldest) {
    return {
      ok: false,
      message: `--from must be ${oldest} or later: Payroll keeps no day older than ${BACKFILL_MAX_AGE_DAYS} days`,
    };
  }
  return { ok: true, from, to: last, dryRun };
}

export interface BackfillDeps {
  /** One date's rows, built and -- unless a dry run -- pushed (syncScorecardDaysForDate). */
  pushDay: (workingDate: string, options: { dryRun: boolean }) => Promise<ScorecardDaysSyncResult>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export interface BackfillSummary {
  /** Dates walked. */
  dates: number;
  /** Dates with engineers on their plan: rows built, and sent unless a dry run. */
  read: number;
  /** Dates with nothing to push: no completed report, or nobody on the plan. */
  skipped: number;
  /** Dates that failed; the backfill carried on past each. */
  failed: number;
  /** Rows Payroll kept, created or replaced; 0 in a dry run. */
  pushed: number;
  /** Every engineer Payroll could not match, once each. */
  unmatched: string[];
}

/**
 * The backfill: one date at a time, oldest first, BACKFILL_PAUSE_MS between
 * dates, so neither OpenCall's database nor Payroll is asked for more than one
 * day at once. One line per date -- its engineers, the rows pushed, who Payroll
 * could not match -- and a summary. A date that fails is reported and passed
 * over; the next one still runs.
 */
export async function runScorecardDaysBackfill(
  args: BackfillArgs,
  deps: BackfillDeps,
): Promise<BackfillSummary> {
  const dates = datesFromTo(args.from, args.to);
  const summary: BackfillSummary = {
    dates: dates.length,
    read: 0,
    skipped: 0,
    failed: 0,
    pushed: 0,
    unmatched: [],
  };
  deps.log(
    `Scorecard days ${args.from} to ${args.to}: ${dates.length} date(s)` +
      (args.dryRun ? " -- DRY RUN, nothing is pushed" : ""),
  );

  for (const [index, date] of dates.entries()) {
    if (index > 0) await deps.sleep(BACKFILL_PAUSE_MS);
    try {
      const result = await deps.pushDay(date, { dryRun: args.dryRun });
      if (result.engineers === 0) {
        summary.skipped += 1;
        deps.log(`${date}  skipped: ${result.message ?? "nothing to push"}`);
        continue;
      }
      summary.read += 1;
      const payroll = result.payroll;
      if (!payroll) {
        // Built and not sent: a dry run. Who Payroll would not match is only
        // known by asking it.
        deps.log(
          `${date}  engineers=${result.engineers}  pushed=0  unmatched=?` +
            `  (${args.dryRun ? "dry run" : (result.message ?? "not sent")})`,
        );
        continue;
      }
      const pushed = payroll.stored + payroll.updated;
      summary.pushed += pushed;
      for (const name of payroll.unmatched) {
        if (!summary.unmatched.includes(name)) summary.unmatched.push(name);
      }
      deps.log(
        `${date}  engineers=${result.engineers}  pushed=${pushed}` +
          `  unmatched=${payroll.unmatched.length}` +
          (payroll.unmatched.length ? ` [${payroll.unmatched.join(", ")}]` : "") +
          (payroll.rejected.length
            ? `  rejected=${payroll.rejected.length} [${payroll.rejected
                .map((rejected) => `#${rejected.index}: ${rejected.reason}`)
                .join("; ")}]`
            : ""),
      );
    } catch (error) {
      summary.failed += 1;
      deps.log(`${date}  FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  deps.log(
    `Done: ${summary.dates} date(s), ${summary.read} read, ${summary.skipped} skipped, ` +
      `${summary.failed} failed; ${summary.pushed} row(s) pushed` +
      (summary.unmatched.length ? `; unmatched: ${summary.unmatched.join(", ")}` : "") +
      (args.dryRun ? " -- dry run, nothing was pushed" : ""),
  );
  return summary;
}
