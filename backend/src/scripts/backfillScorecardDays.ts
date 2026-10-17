/**
 * One-off backfill of the engineers' history in the Payroll app: each past
 * day's Assigned / Attended / Closed per engineer, with the targets, pushed to
 * Payroll's scorecard_days -- the rows the hourly re-push keeps the last week
 * of up to date (payrollSyncScheduler).
 *
 * The numbers are the ones Engineer Productivity shows for each date: the live
 * scorecard's own builder (syncScorecardDaysForDate). A date with no completed
 * report is skipped, never zeroed. Reads OpenCall only; its one write is the
 * push to Payroll. Safe to run again: Payroll keeps one row per engineer per
 * day and replaces it, and never lets a history row replace today's live one.
 *
 * Prod (compiled output, in the OpenCall API container's terminal), dry run
 * first -- it reads every date and pushes nothing:
 *   node dist/scripts/backfillScorecardDays.js --from 2026-07-25 --dry-run
 *   node dist/scripts/backfillScorecardDays.js --from 2026-07-25 [--to YYYY-MM-DD]
 *
 * --to is yesterday (IST) when left out; today is the live push's. One date at
 * a time, a second apart, a line per date. Exits 1 when any date failed.
 * The arguments and the loop live in services/payroll/scorecardDays.ts, where
 * their tests can reach them: this file runs on import.
 */
import "../config/env.js";
import { istTodayIso } from "@opencall/shared";
import { closeDatabasePool } from "../config/database.js";
import { isPayrollConfigured } from "../services/payroll/payrollClient.js";
import {
  BACKFILL_USAGE,
  parseBackfillArgs,
  runScorecardDaysBackfill,
} from "../services/payroll/scorecardDays.js";
import { syncScorecardDaysForDate } from "../services/payroll/syncEngineerScorecards.js";

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2), istTodayIso());
  if (!args.ok) {
    console.error(args.message);
    console.error(BACKFILL_USAGE);
    process.exitCode = 1;
    return;
  }

  if (!isPayrollConfigured()) {
    if (!args.dryRun) {
      console.error(
        "Payroll is not configured (set PAYROLL_API_URL/USER/PASSWORD): nothing can be pushed.",
      );
      process.exitCode = 1;
      return;
    }
    console.warn("Payroll is not configured: a dry run reads the dates, a real run would refuse.");
  }

  const summary = await runScorecardDaysBackfill(args, {
    pushDay: (workingDate, options) => syncScorecardDaysForDate(workingDate, options),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
  });
  if (summary.failed > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabasePool();
  });
