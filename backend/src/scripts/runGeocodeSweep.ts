// Run ONE geocode sweep and print coverage, then exit.
//
// The worker does this on a loop; this is the same pass as a one-shot, for
// running the initial backfill by hand and seeing the numbers immediately
// instead of tailing worker logs.
//
// With no provider configured (the Phase 1 default) this populates the
// pincode-centroid tier for every work order and queues their addresses for
// whenever a provider is switched on. It never calls a provider itself.
//
//   npx tsx src/scripts/runGeocodeSweep.ts        (dev)
//   node dist/scripts/runGeocodeSweep.js          (prod)
import { closeDatabasePool } from "../config/database.js";
import { env } from "../config/env.js";
import {
  expireStaleCacheEntries,
  geocodeTablesPresent,
  getGeocodeCoverage,
} from "../repositories/geocodeRepository.js";
import { runGeocodeSweep } from "../services/geo/geocodingService.js";

function percent(part: number, total: number): string {
  return total === 0 ? "0.0%" : `${((100 * part) / total).toFixed(1)}%`;
}

async function run(): Promise<void> {
  if (!(await geocodeTablesPresent())) {
    console.error(
      "Migration 045 has not been applied (geocode_cache / work_order_geocodes missing). " +
        "Run `npm run migrate:geocoding` first.",
    );
    process.exitCode = 1;
    return;
  }

  const expired = await expireStaleCacheEntries(env.GEOCODE_CACHE_TTL_DAYS);
  if (expired > 0) {
    console.log(`Expired ${expired} cached address(es) past the ${env.GEOCODE_CACHE_TTL_DAYS}-day TTL.\n`);
  }

  const sweep = await runGeocodeSweep();

  console.log("=== GEOCODE SWEEP ===\n");
  console.log(`  examined      : ${sweep.examined}`);
  console.log(`  from cache    : ${sweep.fromCache}`);
  console.log(`  from centroid : ${sweep.fromCentroid}`);
  console.log(`  queued        : ${sweep.enqueued}`);
  console.log(`  upgraded      : ${sweep.upgraded}`);
  console.log(`  unresolvable  : ${sweep.unresolvable}\n`);

  const coverage = await getGeocodeCoverage();
  console.log("=== COVERAGE ===\n");
  console.log(
    `  work orders with a coordinate : ${coverage.workOrdersWithCoordinate}/${coverage.workOrdersTotal} ` +
      `(${percent(coverage.workOrdersWithCoordinate, coverage.workOrdersTotal)})`,
  );
  console.log(`    rooftop          : ${coverage.rooftop}`);
  console.log(`    street           : ${coverage.street}`);
  console.log(`    locality         : ${coverage.locality}`);
  console.log(`    pincode centroid : ${coverage.pincodeCentroid}\n`);
  console.log("=== ADDRESS QUEUE ===\n");
  console.log(`  pending    : ${coverage.queuePending}`);
  console.log(`  processing : ${coverage.queueProcessing}`);
  console.log(`  done       : ${coverage.queueDone} (of which no-match: ${coverage.queueNoMatch})`);
  console.log(`  failed     : ${coverage.queueFailed}\n`);

  if (env.GEOCODE_PROVIDER === "none") {
    console.log(
      `${coverage.queuePending} address(es) are queued and waiting for a provider.\n` +
        "Set GEOCODE_PROVIDER=ola and OLA_MAPS_API_KEY, then run the worker to drain them.",
    );
  }
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
