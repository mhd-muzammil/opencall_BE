import { closeDatabasePool } from "../config/database.js";
import { env } from "../config/env.js";
import {
  claimNextPendingAddress,
  expireStaleCacheEntries,
  geocodeTablesPresent,
  getGeocodeCoverage,
  markAddressFailed,
  markAddressResolved,
  reclaimStaleProcessingAddresses,
  retryFailedAddresses,
  type GeocodeQueueItem,
} from "../repositories/geocodeRepository.js";
import { runGeocodeSweep } from "../services/geo/geocodingService.js";
import { resolveGeocodeProvider } from "../services/geo/providerRegistry.js";
import { GeocodeProviderError, type GeocodeProvider } from "../services/geo/geocodeTypes.js";

/**
 * Standalone worker that drains the `geocode_cache` queue.
 *
 * Modelled on `warrantyWorker.ts` — same claim / pace / reclaim shape — but far
 * lighter: it talks JSON over HTTPS, so no browser and no Playwright, and it
 * runs on the plain API image.
 *
 * It runs as its own process rather than inside the API for the same reason the
 * warranty worker does: a slow or rate-limited third party must never be able to
 * hold an Express request handler open. Report generation must NEVER wait on a
 * geocoder — an upload that depends on a vendor being up is an upload that fails
 * when the vendor is down.
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
  /**
   * Gap between provider calls. Well inside Ola's limits — the queue is bounded
   * by the number of DISTINCT addresses, which after the first backfill is a
   * trickle, so there is nothing to gain from going faster.
   */
  requestSpacingMs: readNumberEnv("GEOCODE_REQUEST_SPACING_MS", 250),
  pollIntervalMs: readNumberEnv("GEOCODE_POLL_INTERVAL_MS", 5_000),
  requestTimeoutMs: readNumberEnv("GEOCODE_REQUEST_TIMEOUT_MS", 15_000),
  /** Parallel lanes. Distinct rows via FOR UPDATE SKIP LOCKED, so N lanes ≈ N×. */
  concurrency: Math.min(readNumberEnv("GEOCODE_CONCURRENCY", 2), 8),
  /** How long an address may sit in `processing` before the lock is assumed dead. */
  staleLockSeconds: readNumberEnv("GEOCODE_STALE_LOCK_SECONDS", 120),
  maxAttempts: readNumberEnv("GEOCODE_MAX_ATTEMPTS", 4),
  /** Work orders examined per sweep. */
  sweepLimit: readNumberEnv("GEOCODE_SWEEP_LIMIT", 2_000),
  sweepIntervalMs: readNumberEnv("GEOCODE_SWEEP_INTERVAL_MS", 15 * 60 * 1000),
};

let isShuttingDown = false;
const shutdownController = new AbortController();

function interruptibleSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (shutdownController.signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Geocode one claimed address.
 *
 * The three-way outcome is the whole contract:
 *   - a result        -> 'done' with coordinates
 *   - provider `null` -> 'done' with precision 'none' (asked, no answer; never ask again)
 *   - a throw         -> 'failed', retryable by the housekeeping sweep
 *
 * @returns true when the provider was actually contacted, so the lane paces itself.
 */
async function processAddress(
  provider: GeocodeProvider,
  item: GeocodeQueueItem,
): Promise<boolean> {
  const timeout = AbortSignal.timeout(config.requestTimeoutMs);
  // Abort on shutdown as well as on timeout, so SIGTERM does not wait out a hung
  // provider connection.
  const signal = AbortSignal.any([timeout, shutdownController.signal]);

  try {
    const result = await provider.geocode(item.addressText, signal);

    if (!result) {
      await markAddressResolved({
        addressKey: item.addressKey,
        latitude: null,
        longitude: null,
        precision: "none",
        provider: provider.name,
        formattedAddress: null,
        locality: null,
      });
      console.log(`[geocode] ${item.addressKey}: no match (cached as 'none')`);
      return true;
    }

    await markAddressResolved({
      addressKey: item.addressKey,
      latitude: result.latitude,
      longitude: result.longitude,
      precision: result.precision,
      provider: provider.name,
      formattedAddress: result.formattedAddress,
      locality: result.locality,
    });
    console.log(
      `[geocode] ${item.addressKey}: ${result.precision} ` +
        `(${result.latitude.toFixed(5)}, ${result.longitude.toFixed(5)})` +
        `${result.locality ? ` locality="${result.locality}"` : ""}`,
    );
    return true;
  } catch (error) {
    const message = errorMessage(error);
    await markAddressFailed(item.addressKey, message);

    // A non-retryable provider error means the REQUEST is wrong (bad key, bad
    // params) — say so loudly, because retrying will never fix it and the queue
    // would otherwise look merely slow rather than misconfigured.
    const fatal = error instanceof GeocodeProviderError && !error.retryable;
    console.error(
      `[geocode] ${item.addressKey}: FAILED${fatal ? " (not retryable)" : ""} — ${message}`,
    );
    return true;
  }
}

/**
 * The gap this provider must observe between calls.
 *
 * A provider's own floor always wins over the configured value: OpenCage's free
 * tier is a hard 1 request/second, so the 250ms default would spend the run
 * generating 429s — each of which burns an attempt against GEOCODE_MAX_ATTEMPTS
 * and eventually fails addresses that were never actually bad.
 *
 * Concurrency multiplies the rate, so the floor is scaled by the lane count to
 * keep the AGGREGATE rate inside the limit.
 */
function laneSpacingMs(provider: GeocodeProvider): number {
  const providerFloor = (provider.minRequestSpacingMs ?? 0) * config.concurrency;
  return Math.max(config.requestSpacingMs, providerFloor);
}

/** One drain lane: claim, geocode, pace, repeat. */
async function drainLane(provider: GeocodeProvider): Promise<void> {
  const spacingMs = laneSpacingMs(provider);

  while (!isShuttingDown) {
    let item: GeocodeQueueItem | null;
    try {
      item = await claimNextPendingAddress();
    } catch (error) {
      console.error(`[geocode] claim failed — ${errorMessage(error)}`);
      await interruptibleSleep(config.pollIntervalMs);
      continue;
    }

    if (!item) {
      await interruptibleSleep(config.pollIntervalMs);
      continue;
    }

    const contacted = await processAddress(provider, item);
    if (contacted && !isShuttingDown) {
      await interruptibleSleep(spacingMs);
    }
  }
}

/**
 * Housekeeping: run the sweep, expire stale cache entries, recover stale locks,
 * requeue transient failures, and report coverage.
 *
 * This lane runs even with NO provider configured — the pincode-centroid tier
 * and the coverage numbers are useful on their own, which is exactly what
 * Phase 1 ships.
 */
async function housekeepingLane(): Promise<void> {
  let lastSweepAt = 0;

  while (!isShuttingDown) {
    try {
      const now = Date.now();
      if (now - lastSweepAt >= config.sweepIntervalMs) {
        lastSweepAt = now;

        // Expire BEFORE sweeping, so anything the TTL pushes back to 'pending'
        // is picked up in the same cycle rather than waiting another interval.
        const expired = await expireStaleCacheEntries(env.GEOCODE_CACHE_TTL_DAYS);
        if (expired > 0) {
          console.log(
            `[geocode] expired ${expired} cached address(es) older than ` +
              `${env.GEOCODE_CACHE_TTL_DAYS} day(s) — requeued`,
          );
        }

        const sweep = await runGeocodeSweep(config.sweepLimit);
        if (sweep.available && sweep.examined + sweep.upgraded > 0) {
          console.log(
            `[geocode] sweep: examined=${sweep.examined} cache=${sweep.fromCache} ` +
              `centroid=${sweep.fromCentroid} queued=${sweep.enqueued} ` +
              `upgraded=${sweep.upgraded} unresolvable=${sweep.unresolvable}`,
          );
        }

        const requeued = await retryFailedAddresses(config.maxAttempts);
        if (requeued > 0) {
          console.log(`[geocode] requeued ${requeued} previously failed address(es)`);
        }

        const coverage = await getGeocodeCoverage();
        const pct =
          coverage.workOrdersTotal > 0
            ? ((coverage.workOrdersWithCoordinate / coverage.workOrdersTotal) * 100).toFixed(1)
            : "0.0";
        console.log(
          `[geocode] coverage: ${coverage.workOrdersWithCoordinate}/${coverage.workOrdersTotal} ` +
            `work orders (${pct}%) — rooftop=${coverage.rooftop} street=${coverage.street} ` +
            `locality=${coverage.locality} centroid=${coverage.pincodeCentroid} | ` +
            `queue pending=${coverage.queuePending} failed=${coverage.queueFailed} ` +
            `no-match=${coverage.queueNoMatch}`,
        );
      }

      const reclaimed = await reclaimStaleProcessingAddresses(
        config.staleLockSeconds,
        config.maxAttempts,
      );
      if (reclaimed.requeued > 0 || reclaimed.exhausted > 0) {
        console.warn(
          `[geocode] reclaimed stale locks: ${reclaimed.requeued} requeued, ` +
            `${reclaimed.exhausted} failed (attempt limit)`,
        );
      }
    } catch (error) {
      console.error(`[geocode] housekeeping failed — ${errorMessage(error)}`);
    }

    await interruptibleSleep(config.pollIntervalMs);
  }
}

async function run(): Promise<void> {
  if (!(await geocodeTablesPresent())) {
    console.error(
      "[geocode] migration 045 has not been applied (geocode_cache / work_order_geocodes missing). " +
        "Run `npm run migrate:geocoding` first.",
    );
    process.exitCode = 1;
    return;
  }

  const provider = resolveGeocodeProvider();

  if (!provider) {
    // Deliberately not fatal: the centroid tier still works, so coverage is
    // still populated — just coarse. Loud enough that nobody mistakes it for
    // precise.
    console.warn(
      "[geocode] NO PROVIDER CONFIGURED — running the pincode-centroid tier only. " +
        "Every work order will sit at ~2km accuracy until GEOCODE_PROVIDER and its key are set.",
    );
    await housekeepingLane();
    return;
  }

  const spacingMs = laneSpacingMs(provider);
  console.log(
    `[geocode] worker starting (provider=${provider.name}, concurrency=${config.concurrency}, ` +
      `spacing=${spacingMs}ms${spacingMs > config.requestSpacingMs ? " (raised to the provider's own limit)" : ""}, ` +
      `cacheTtlDays=${env.GEOCODE_CACHE_TTL_DAYS || "never"})`,
  );

  await Promise.all([
    housekeepingLane(),
    ...Array.from({ length: config.concurrency }, () => drainLane(provider)),
  ]);
}

function shutdown(signal: NodeJS.Signals): void {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log(`[geocode] received ${signal}; finishing current addresses`);
  shutdownController.abort();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

try {
  await run();
} catch (error) {
  console.error("[geocode] worker crashed", error);
  process.exitCode = 1;
} finally {
  await closeDatabasePool().catch((error: unknown) => {
    console.error("[geocode] failed to close database pool", error);
  });
  console.log("[geocode] worker stopped");
}
