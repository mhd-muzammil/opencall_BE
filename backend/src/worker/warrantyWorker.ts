import { chromium, type BrowserContext, type Page } from "playwright";
import { closeDatabasePool } from "../config/database.js";
import {
  findCachedWarranty,
  upsertWarrantyCache,
} from "../repositories/warrantyCacheRepository.js";
import {
  claimNextPendingItem,
  markItemDone,
  markItemFailed,
  reclaimStaleProcessingItems,
  type WarrantyJobItem,
} from "../repositories/warrantyJobItemRepository.js";
import {
  DEFAULT_HP_WARRANTY_URL,
  lookupWarranty,
} from "../services/warranty/hpWarrantyClient.js";
import { runDailyClosedCallSweep } from "../services/warranty/closedCallWarrantyService.js";

/**
 * Standalone worker that drains the `warranty_job_items` queue.
 *
 * This is the *only* process that runs Playwright — the Express API never imports
 * a browser. It runs in its own container (see `Dockerfile.warranty-worker`).
 *
 * HP guards the form with invisible reCAPTCHA v3, which we do not try to defeat.
 * Instead we behave like a slow human: one warm, persistent browser profile on a
 * mounted volume, and a randomized 6–12s gap between requests. If HP ever shows
 * an *interactive* challenge the item is failed and left for a later retry.
 */

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const config = {
  hpUrl: process.env.WARRANTY_HP_URL || DEFAULT_HP_WARRANTY_URL,
  minDelayMs: readNumberEnv("WARRANTY_MIN_DELAY_MS", 6_000),
  maxDelayMs: readNumberEnv("WARRANTY_MAX_DELAY_MS", 12_000),
  pollIntervalMs: readNumberEnv("WARRANTY_POLL_INTERVAL_MS", 5_000),
  profileDir: process.env.WARRANTY_PROFILE_DIR || "/data/warranty-profile",
  /**
   * How many serials to look up in parallel. Each lane gets its own page in the
   * one shared (warm) browser context, and they claim distinct queue rows via
   * `FOR UPDATE SKIP LOCKED`, so N lanes ≈ N× throughput. Each lane still paces
   * itself by `min/maxDelayMs`, so the aggregate request rate is roughly
   * `concurrency / delay` — raise this to drain a backlog faster, but watch the
   * `failed` count: too much traffic from one IP invites HP's reCAPTCHA. Capped
   * at 8 (one warm context can't sanely juggle more pages).
   */
  concurrency: Math.min(readNumberEnv("WARRANTY_CONCURRENCY", 3), 8),
  /**
   * How long an item may sit in `processing` before we assume the worker that
   * claimed it died. Generously above the 45s lookup timeout plus the pacing
   * delay, so a slow-but-alive worker is never robbed of its item.
   */
  staleLockSeconds: readNumberEnv("WARRANTY_STALE_LOCK_SECONDS", 300),
  /** Claims a single serial may burn before it is failed instead of requeued. */
  maxAttempts: readNumberEnv("WARRANTY_MAX_ATTEMPTS", 5),
};

let isShuttingDown = false;
/**
 * Aborted on shutdown so every in-flight `interruptibleSleep` resolves at once —
 * a shared signal instead of a single callback, since many lanes sleep at the
 * same time.
 */
const shutdownController = new AbortController();

/**
 * Closed-calls auto sweep: periodically enqueue uncached serials from the latest report's
 * closed calls (capped ~100/day in the service). Throttled here so we do not sweep every
 * poll; the daily cap lives in the service, so a coarse hourly check is plenty.
 */
const CLOSED_CALL_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastClosedCallSweepAt = 0;

async function maybeSweepClosedCalls(): Promise<void> {
  const now = Date.now();
  if (now - lastClosedCallSweepAt < CLOSED_CALL_SWEEP_INTERVAL_MS) return;
  lastClosedCallSweepAt = now;
  try {
    const { enqueued } = await runDailyClosedCallSweep();
    if (enqueued > 0) {
      console.log(`[warranty] closed-calls sweep enqueued ${enqueued} serial(s)`);
    }
  } catch (error) {
    console.error("[warranty] closed-calls sweep failed", error);
  }
}

/**
 * A `setTimeout` sleep that also resolves the instant shutdown is signalled, so
 * a lane never sits out a full pacing delay while the process is trying to exit.
 * Safe to call from many lanes concurrently (unlike a single shared callback):
 * the abort listener is removed when the timer wins, so listeners never pile up
 * over the worker's lifetime.
 */
function interruptibleSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (shutdownController.signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      shutdownController.signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    shutdownController.signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Randomized pacing between HP requests, per the reCAPTCHA-friendly budget. */
function nextDelayMs(): number {
  const min = Math.min(config.minDelayMs, config.maxDelayMs);
  const max = Math.max(config.minDelayMs, config.maxDelayMs);
  return min + Math.floor(Math.random() * (max - min + 1));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Processes one claimed item.
 * @returns true when HP was actually contacted (the caller then paces itself).
 */
async function processItem(page: Page, item: WarrantyJobItem): Promise<boolean> {
  // Another job may have fetched this serial while the item sat in the queue.
  const cached = await findCachedWarranty(item.serial);
  if (cached) {
    await markItemDone(item.id, {
      lookupStatus: cached.lookupStatus,
      endDate: cached.endDate,
      hpStatus: cached.hpStatus,
    });
    console.log(`[warranty] ${item.serial}: cache hit (${cached.lookupStatus})`);
    return false;
  }

  try {
    const result = await lookupWarranty(page, item.serial, item.productNumber, {
      hpUrl: config.hpUrl,
    });

    // Only terminal results are cached. FAILED stays retryable by design.
    await upsertWarrantyCache({
      serial: item.serial,
      lookupStatus: result.lookupStatus,
      startDate: result.startDate,
      endDate: result.endDate,
      productNumber: item.productNumber,
      hpStatus: result.hpStatus,
    });

    await markItemDone(item.id, {
      lookupStatus: result.lookupStatus,
      endDate: result.endDate,
      hpStatus: result.hpStatus,
    });

    console.log(
      `[warranty] ${item.serial}: ${result.lookupStatus}${
        result.endDate ? ` (ends ${result.endDate})` : ""
      }`,
    );
  } catch (error) {
    const message = errorMessage(error);
    await markItemFailed(item.id, message);
    console.error(`[warranty] ${item.serial}: FAILED — ${message}`);
  }

  return true;
}

/**
 * One drain lane: claim the next pending item, look it up on its own page, pace,
 * repeat. Many lanes run concurrently against the same queue — `FOR UPDATE SKIP
 * LOCKED` in `claimNextPendingItem` hands each lane a distinct row.
 */
async function drainLane(page: Page): Promise<void> {
  while (!isShuttingDown) {
    let item: WarrantyJobItem | null;
    try {
      item = await claimNextPendingItem();
    } catch (error) {
      // A transient DB hiccup must not kill the lane; back off and retry.
      console.error(`[warranty] claim failed — ${errorMessage(error)}`);
      await interruptibleSleep(config.pollIntervalMs);
      continue;
    }

    if (!item) {
      await interruptibleSleep(config.pollIntervalMs);
      continue;
    }

    const contactedHp = await processItem(page, item);

    if (contactedHp && !isShuttingDown) {
      await interruptibleSleep(nextDelayMs());
    }
  }
}

/**
 * Housekeeping runs on its own cadence, independent of the drain lanes: feed the
 * queue from the latest report's closed calls, and recover items a crashed
 * worker abandoned mid-flight (stuck in 'processing') so their job can complete.
 */
async function housekeepingLane(): Promise<void> {
  while (!isShuttingDown) {
    try {
      await maybeSweepClosedCalls();

      const reclaimed = await reclaimStaleProcessingItems(
        config.staleLockSeconds,
        config.maxAttempts,
      );
      if (reclaimed.requeued > 0 || reclaimed.exhausted > 0) {
        console.warn(
          `[warranty] reclaimed stale locks: ${reclaimed.requeued} requeued, ${reclaimed.exhausted} failed (attempt limit)`,
        );
      }
    } catch (error) {
      console.error(`[warranty] housekeeping failed — ${errorMessage(error)}`);
    }
    await interruptibleSleep(config.pollIntervalMs);
  }
}

async function run(): Promise<void> {
  console.log(
    `[warranty] worker starting (profile=${config.profileDir}, concurrency=${config.concurrency}, delay=${config.minDelayMs}-${config.maxDelayMs}ms)`,
  );

  // A persistent context keeps cookies and the reCAPTCHA v3 reputation warm
  // across restarts — the profile dir is a mounted volume.
  const context: BrowserContext = await chromium.launchPersistentContext(
    config.profileDir,
    {
      headless: true,
      viewport: { width: 1366, height: 900 },
      args: [
        // Chromium's namespace sandbox needs unprivileged user namespaces, which
        // Docker's default seccomp profile blocks. The container is the isolation
        // boundary here.
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    },
  );

  // One page per drain lane, reused for that lane's whole run (cheaper than a
  // page per lookup and keeps the warm session).
  const pages: Page[] = [context.pages()[0] ?? (await context.newPage())];
  for (let i = 1; i < config.concurrency; i += 1) {
    pages.push(await context.newPage());
  }

  try {
    await Promise.all([
      housekeepingLane(),
      ...pages.map((page) => drainLane(page)),
    ]);
  } finally {
    await context.close().catch((error: unknown) => {
      console.error("[warranty] failed to close browser context", error);
    });
  }
}

function shutdown(signal: NodeJS.Signals): void {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`[warranty] received ${signal}; finishing current items`);
  shutdownController.abort();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

try {
  await run();
} catch (error) {
  console.error("[warranty] worker crashed", error);
  process.exitCode = 1;
} finally {
  await closeDatabasePool().catch((error: unknown) => {
    console.error("[warranty] failed to close database pool", error);
  });
  console.log("[warranty] worker stopped");
}
