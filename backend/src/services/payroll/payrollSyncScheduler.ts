/**
 * Automatic background sync of assigned cases into Payroll — so engineers see
 * their cases WITHOUT anyone clicking a button.
 *
 * Runs shortly after boot and then on a fixed interval, syncing ONLY TODAY's
 * assignments — each engineer should see the cases assigned to them today, not
 * older history. Idempotent (external_ref = ticketId), so re-running every cycle
 * is cheap and never duplicates. No-op when Payroll isn't configured.
 *
 * This complements the live per-assign dispatch (reportRowEditService), which
 * still pushes NEW assignments instantly; the scheduler is the hands-off safety
 * net so nothing needs a manual "Sync" click.
 */
import { istTodayIso } from "@opencall/shared";
import { isPayrollConfigured } from "./payrollClient.js";
import { syncAssignedCasesForDate } from "./syncAssignedCases.js";

const INTERVAL_MS = 5 * 60 * 1000; // run every 5 minutes
const INITIAL_DELAY_MS = 30 * 1000; // first run 30s after boot (let it settle)

async function runOnce(): Promise<void> {
  // Only TODAY's assignments — each engineer should see the cases assigned to
  // them today, not older days' history.
  const date = istTodayIso();
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

let soonTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Near-instant sync (debounced ~2s) — call this the moment an assignment
 * changes so Payroll reflects the new "Assigned" set right away, instead of
 * waiting for the periodic tick. Debounced so a burst of edits coalesces into
 * one sync. Fire-and-forget; no-op when Payroll isn't configured.
 */
export function schedulePayrollSyncSoon(): void {
  if (!isPayrollConfigured() || soonTimer) {
    return;
  }
  soonTimer = setTimeout(() => {
    soonTimer = null;
    void runOnce();
  }, 2000);
  soonTimer.unref();
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
    `[payroll] auto-sync enabled: today's assignments, every ${INTERVAL_MS / 60000} min`,
  );
}
