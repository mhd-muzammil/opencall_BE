// Fills office_pincode_distances with REAL routed distances, replacing the
// straight-line estimate that misses by an average of 5.2km.
//
// Routes every branch office in region_offices against every pincode in
// pincode_geo that is missing a distance. Existing rows are left alone unless
// --refresh is passed, so a re-run after adding one pincode costs one route, not
// two hundred.
//
// Usage:
//   npx tsx src/scripts/computeRoadDistances.ts                 (dev)
//   node dist/scripts/computeRoadDistances.js                   (prod)
//   ... --asp ASPS01461     just one branch
//   ... --refresh           recompute pairs that already have a distance
//   ... --limit 50          cap the work (useful against the public server)
import { closeDatabasePool, pool } from "../config/database.js";
import { routeProviderAddressDistances } from "../services/geo/addressRoutingService.js";
import { OsrmRoadDistanceProvider } from "../services/geo/roadDistanceProvider.js";

interface Pair {
  aspCode: string;
  pincode: string;
  latitude: number;
  longitude: number;
}

function flag(name: string): string | null {
  const at = process.argv.indexOf(name);

  return at !== -1 ? (process.argv[at + 1] ?? null) : null;
}

async function run(): Promise<void> {
  const aspFilter = flag("--asp")?.toUpperCase() ?? null;
  const refresh = process.argv.includes("--refresh");
  const limit = Number.parseInt(flag("--limit") ?? "", 10);

  const offices = await pool.query<{
    asp_code: string;
    label: string;
    latitude: string;
    longitude: string;
  }>(
    `SELECT asp_code, label, latitude, longitude FROM region_offices
      WHERE $1::text IS NULL OR asp_code = $1`,
    [aspFilter],
  );

  if (offices.rowCount === 0) {
    console.log("No offices to route from. Seed region_offices first.");
    return;
  }

  const provider = new OsrmRoadDistanceProvider();
  let written = 0;

  for (const office of offices.rows) {
    // Only pincodes that actually have a coordinate can be routed, and by
    // default only those still missing a distance for THIS office.
    const targets = await pool.query<{ pincode: string; latitude: string; longitude: string }>(
      `SELECT g.pincode, g.latitude, g.longitude
         FROM pincode_geo g
         LEFT JOIN office_pincode_distances d
           ON d.pincode = g.pincode AND d.asp_code = $1
        WHERE ($2::boolean OR d.pincode IS NULL)
        ORDER BY g.pincode`,
      [office.asp_code, refresh],
    );

    const pairs: Pair[] = targets.rows
      .map((row) => ({
        aspCode: office.asp_code,
        pincode: row.pincode,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
      }))
      .slice(0, Number.isFinite(limit) && limit > 0 ? limit : undefined);

    if (pairs.length === 0) {
      console.log(`${office.label}: already complete.`);
      continue;
    }

    console.log(`${office.label}: routing ${pairs.length} pincodes...`);

    const distances = await provider.distancesFrom(
      { latitude: Number(office.latitude), longitude: Number(office.longitude) },
      pairs,
    );

    const routed = pairs
      .map((pair, index) => ({ pair, km: distances[index] ?? null }))
      .filter((entry): entry is { pair: Pair; km: number } => entry.km !== null);

    const unreachable = pairs.length - routed.length;

    for (let i = 0; i < routed.length; i += 200) {
      const chunk = routed.slice(i, i + 200);
      const values: unknown[] = [];
      const tuples = chunk.map((entry, n) => {
        values.push(entry.pair.aspCode, entry.pair.pincode, Number(entry.km.toFixed(1)));
        return `($${n * 3 + 1}, $${n * 3 + 2}, $${n * 3 + 3})`;
      });

      const result = await pool.query(
        `INSERT INTO office_pincode_distances (asp_code, pincode, road_km)
         VALUES ${tuples.join(", ")}
         ON CONFLICT (asp_code, pincode) DO UPDATE
           SET road_km = EXCLUDED.road_km,
               provider = EXCLUDED.provider,
               computed_at = NOW()`,
        values,
      );
      written += result.rowCount ?? 0;
    }

    // Logged rather than swallowed: an unroutable centroid keeps showing the
    // straight-line estimate, and nobody would otherwise know which ones.
    if (unreachable > 0) {
      console.log(`  ${unreachable} pincodes had no route and keep the estimate.`);
    }
  }

  console.log(`\nWrote ${written} routed distances.`);

  // The same pass for geocoded ADDRESSES (office_address_distances). A manual
  // backfill must cover both tables, or freshly geocoded rows sit invisible
  // until the worker's next sweep.
  const addressRouting = await routeProviderAddressDistances({
    provider,
    refresh,
    aspCode: aspFilter,
  });
  if (addressRouting.available) {
    console.log(
      `Address routing: examined=${addressRouting.examined} routed=${addressRouting.routed} ` +
        `unreachable=${addressRouting.unreachable} gate-skipped=${addressRouting.skippedByGate}`,
    );
  } else {
    console.log("office_address_distances is not migrated yet — address routing skipped.");
  }
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
