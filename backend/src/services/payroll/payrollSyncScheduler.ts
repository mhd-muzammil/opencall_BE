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
import { SCORECARD_REPUSH_DAYS, scorecardRepushDates } from "./scorecardDays.js";
import { syncAssignedCasesForDate } from "./syncAssignedCases.js";
import {
  syncEngineerScorecardsForDate,
  syncScorecardDaysForDate,
} from "./syncEngineerScorecards.js";

// Every 2 minutes. The push is idempotent on ticket id and a whole day is only a
// few dozen rows, so the cost is negligible next to an engineer sitting in front
// of a customer while their newly booked call has not arrived yet.
const INTERVAL_MS = 2 * 60 * 1000;
const INITIAL_DELAY_MS = 30 * 1000; // first run 30s after boot (let it settle)

// The engineers' history days: the week before today, re-pushed once an hour.
// First run 5 min after boot, well clear of the first case sync, so a deploy
// does not push back the next re-push by up to an hour.
const HISTORY_INTERVAL_MS = 60 * 60 * 1000;
const HISTORY_INITIAL_DELAY_MS = 5 * 60 * 1000;

async function runOnce(): Promise<void> {
  // Only TODAY's assignments — each engineer should see the cases assigned to
  // them today, not older days' history.
  const date = istTodayIso();
  try {
    const result = await syncAssignedCasesForDate(date);
    if (result.payroll && result.payroll.assigned + result.payroll.skipped > 0) {
      const { assigned, skipped, cancelled, unmatched_engineers: unmatched } = result.payroll;
      console.log(
        `[payroll] auto-sync ${date}: assigned=${assigned} skipped=${skipped} ` +
          `cancelled=${cancelled ?? 0} rows=${result.rowsWithEngineer}` +
          // The engineers Payroll could not match — the onboarding to-do list.
          // Without this, a sync that pushes nothing looks identical to a
          // healthy one and there is nothing to act on.
          (unmatched?.length ? ` unmatched=[${unmatched.join(", ")}]` : ""),
      );
    } else {
      // Nothing was pushed. ALWAYS say why — a silent no-op here is exactly how
      // "the dashboard shows 56 assigned but Payroll is empty" goes unnoticed.
      console.log(`[payroll] auto-sync ${date}: nothing pushed — ${result.message ?? "no reason given"}`);
    }
  } catch (error) {
    console.error(
      `[payroll] auto-sync ${date} failed:`,
      error instanceof Error ? error.message : error,
    );
  }

  // Then the numbers. Its own try/catch on purpose: the case sync above is what
  // an engineer's whole day depends on, and a scorecard that fails to push must
  // cost nothing but a scorecard. Runs after, never before, for the same reason.
  try {
    const scorecards = await syncEngineerScorecardsForDate(date);
    if (scorecards.payroll) {
      const { saved, zeroed, skipped } = scorecards.payroll;
      console.log(
        `[payroll] scorecards ${date}: saved=${saved} zeroed=${zeroed}` +
          (skipped.length
            ? ` unmatched=[${skipped.map((s) => s.engineer_name ?? "?").join(", ")}]`
            : ""),
      );
    } else {
      console.log(
        `[payroll] scorecards ${date}: nothing pushed — ${scorecards.message ?? "no reason given"}`,
      );
    }
  } catch (error) {
    console.error(
      `[payroll] scorecards ${date} failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}

let historyRunning = false;

/**
 * Re-push the engineers' history days for the week before today. The live
 * push above stops at midnight, so the last numbers it sent for a day may not
 * be the day's final ones -- an Evening status edited late, a Final EOD
 * freezing the day. A day with no completed report is skipped, never zeroed.
 *
 * Each date has its own try/catch, so one bad date costs only that date, and
 * nothing here ever throws. A run still going when the next is due is not
 * joined by a second.
 */
export async function runScorecardDaysOnce(today: string = istTodayIso()): Promise<void> {
  if (historyRunning) return;
  historyRunning = true;
  try {
    for (const date of scorecardRepushDates(today)) {
      try {
        const result = await syncScorecardDaysForDate(date);
        if (result.payroll) {
          const { stored, updated, unmatched, rejected } = result.payroll;
          console.log(
            `[payroll] scorecard days ${date}: stored=${stored} updated=${updated}` +
              (unmatched.length ? ` unmatched=[${unmatched.join(", ")}]` : "") +
              (rejected.length
                ? ` rejected=[${rejected.map((r) => `#${r.index} ${r.reason}`).join("; ")}]`
                : ""),
          );
        } else {
          console.log(
            `[payroll] scorecard days ${date}: nothing pushed — ${result.message ?? "no reason given"}`,
          );
        }
      } catch (error) {
        console.error(
          `[payroll] scorecard days ${date} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  } catch (error) {
    console.error(
      "[payroll] scorecard days failed:",
      error instanceof Error ? error.message : error,
    );
  } finally {
    historyRunning = false;
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

  const historyInitial = setTimeout(() => void runScorecardDaysOnce(), HISTORY_INITIAL_DELAY_MS);
  historyInitial.unref();
  const historyTimer = setInterval(() => void runScorecardDaysOnce(), HISTORY_INTERVAL_MS);
  historyTimer.unref();

  console.log(
    `[payroll] scorecard days enabled: the ${SCORECARD_REPUSH_DAYS} days before today, ` +
      `every ${HISTORY_INTERVAL_MS / 60000} min`,
  );
}
