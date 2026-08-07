/**
 * Automatic background sync of assigned cases into Payroll — so engineers see
 * their cases WITHOUT anyone clicking a button.
 *
 * Runs shortly after boot and then on a fixed interval, syncing the last few
 * working days. Idempotent (external_ref = ticketId), so re-running every cycle
 * is cheap and never duplicates. No-op when Payroll isn't configured.
 *
 * This complements the live per-assign dispatch (reportRowEditService), which
 * still pushes NEW assignments instantly; the scheduler catches historical rows
 * and anything the live path missed, so the whole thing is hands-off.
 */
import { istTodayIso } from "@opencall/shared";
import { isPayrollConfigured } from "./payrollClient.js";
import { syncAssignedCasesForDate } from "./syncAssignedCases.js";

const INTERVAL_MS = 5 * 60 * 1000; // run every 5 minutes
const INITIAL_DELAY_MS = 30 * 1000; // first run 30s after boot (let it settle)
const DAYS_BACK = 3; // sync today + the 2 previous working days

function recentWorkingDates(): string[] {
  const dates: string[] = [];
  for (let i = 0; i < DAYS_BACK; i += 1) {
    dates.push(istTodayIso(new Date(Date.now() - i * 24 * 60 * 60 * 1000)));
  }
  return dates;
}

async function runOnce(): Promise<void> {
  for (const date of recentWorkingDates()) {
    try {
      const result = await syncAssignedCasesForDate(date);
      if (result.payroll && result.payroll.assigned + result.payroll.skipped > 0) {
        console.log(
          `[payroll] auto-sync ${date}: assigned=${result.payroll.assigned} ` +
            `skipped=${result.payroll.skipped} rows=${result.rowsWithEngineer}`,
        );
      }
    } catch (error) {
      console.error(
        `[payroll] auto-sync ${date} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

export function startPayrollSyncScheduler(): void {
  if (!isPayrollConfigured()) {
    console.log("[payroll] auto-sync disabled (PAYROLL_API_URL/USER/PASSWORD not set)");
    return;
  }

  const initial = setTimeout(() => void runOnce(), INITIAL_DELAY_MS);
  initial.unref();
  const timer = setInterval(() => void runOnce(), INTERVAL_MS);
  timer.unref();

  console.log(
    `[payroll] auto-sync enabled: every ${INTERVAL_MS / 60000} min for the last ${DAYS_BACK} days`,
  );
}
