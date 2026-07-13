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
  type WarrantyJobItem,
} from "../repositories/warrantyJobItemRepository.js";
import {
  DEFAULT_HP_WARRANTY_URL,
  lookupWarranty,
} from "../services/warranty/hpWarrantyClient.js";

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
};

let isShuttingDown = false;
/** Resolves early when a shutdown signal lands, so we never sit out a full delay. */
let wakeUp: (() => void) | null = null;

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeUp = null;
      resolve();
    }, durationMs);

    wakeUp = () => {
      clearTimeout(timer);
      wakeUp = null;
      resolve();
    };
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

async function run(): Promise<void> {
  console.log(
    `[warranty] worker starting (profile=${config.profileDir}, delay=${config.minDelayMs}-${config.maxDelayMs}ms)`,
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

  const page = context.pages()[0] ?? (await context.newPage());

  try {
    while (!isShuttingDown) {
      const item = await claimNextPendingItem();

      if (!item) {
        await sleep(config.pollIntervalMs);
        continue;
      }

      const contactedHp = await processItem(page, item);

      if (contactedHp && !isShuttingDown) {
        await sleep(nextDelayMs());
      }
    }
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
  console.log(`[warranty] received ${signal}; finishing current item`);
  wakeUp?.();
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
