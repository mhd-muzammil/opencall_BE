import { query } from "../../config/database.js";
import { passesPincodeGate } from "../../utils/geo.js";
import {
  OsrmRoadDistanceProvider,
  type RoadDistanceProvider,
} from "./roadDistanceProvider.js";

/**
 * Routes provider-geocoded ADDRESSES from every branch office, the way
 * computeRoadDistances routes pincode centroids.
 *
 * This is the piece that makes the exact-address tier visible at all: the
 * matching engine only uses a provider coordinate once its road distance
 * exists (swapping a routed centroid figure for a straight-line "precise" one
 * would trade a good number for a worse-looking one), so an address that is
 * geocoded but never routed stays invisible forever.
 *
 * Runs from two places with one implementation: the geocoding worker's
 * housekeeping lane (tops up freshly resolved addresses every sweep) and the
 * computeRoadDistances script (manual backfill).
 *
 * THE GATE RUNS HERE TOO. An address that fails the pincode sanity check (a
 * billing-office address 85 km from the service site, a provider answer in the
 * wrong town) will never be used by the matching engine, so routing it would
 * spend OSRM calls on a coordinate nothing reads. Skipped, and counted so the
 * log says how many.
 */

/** Bounded per office per run; the worker calls this every sweep, so a backlog drains in a few cycles. */
const DEFAULT_LIMIT_PER_OFFICE = 500;

export interface AddressRoutingResult {
  /** False when the tables involved are not all migrated yet. */
  available: boolean;
  /** (office, address) pairs examined. */
  examined: number;
  /** Pairs routed and written. */
  routed: number;
  /** Pairs OSRM could not route (kept unwritten; retried next run). */
  unreachable: number;
  /** Addresses skipped because their coordinate fails the pincode sanity gate. */
  skippedByGate: number;
}

const EMPTY: AddressRoutingResult = {
  available: false,
  examined: 0,
  routed: 0,
  unreachable: 0,
  skippedByGate: 0,
};

interface OfficeRow {
  asp_code: string;
  label: string;
  latitude: string;
  longitude: string;
}

interface TargetRow {
  address_key: string;
  latitude: string;
  longitude: string;
  pin_latitude: string;
  pin_longitude: string;
}

export interface AddressRoutingOptions {
  provider?: RoadDistanceProvider;
  /** Recompute pairs that already have a distance (after a re-geocode). */
  refresh?: boolean;
  /** Route from one branch only. */
  aspCode?: string | null;
  limitPerOffice?: number;
}

export async function routeProviderAddressDistances(
  options: AddressRoutingOptions = {},
): Promise<AddressRoutingResult> {
  const present = await query<{ present: boolean }>(
    `
      SELECT COUNT(*) = 4 AS present
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('office_address_distances', 'geocode_cache',
                           'region_offices', 'pincode_geo')
    `,
  );
  if (!present.rows[0]?.present) {
    return EMPTY;
  }

  const provider = options.provider ?? new OsrmRoadDistanceProvider();
  const refresh = options.refresh ?? false;
  const aspFilter = options.aspCode?.trim().toUpperCase() ?? null;
  const limit = options.limitPerOffice ?? DEFAULT_LIMIT_PER_OFFICE;

  const offices = await query<OfficeRow>(
    `SELECT asp_code, label, latitude, longitude FROM region_offices
      WHERE $1::text IS NULL OR asp_code = $1`,
    [aspFilter],
  );

  const result: AddressRoutingResult = { ...EMPTY, available: true };

  for (const office of offices.rows) {
    // Addresses the provider resolved, joined to their own pincode's centroid
    // so the sanity gate can run — an address whose pincode has no centroid
    // cannot be checked and is deliberately absent (INNER JOIN): unverifiable
    // is treated as unusable, exactly as the matching engine treats it.
    const targets = await query<TargetRow>(
      `
        SELECT g.address_key, g.latitude, g.longitude,
               p.latitude AS pin_latitude, p.longitude AS pin_longitude
          FROM geocode_cache g
          JOIN pincode_geo p ON p.pincode = g.pincode
          LEFT JOIN office_address_distances d
            ON d.address_key = g.address_key AND d.asp_code = $1
         WHERE g.state = 'done'
           AND g.precision <> 'none'
           AND g.latitude IS NOT NULL
           AND g.longitude IS NOT NULL
           AND ($2::boolean OR d.address_key IS NULL)
         ORDER BY g.address_key
         LIMIT $3
      `,
      [office.asp_code, refresh, limit],
    );

    result.examined += targets.rows.length;

    const gated = targets.rows.filter((row) =>
      passesPincodeGate(
        { latitude: Number(row.latitude), longitude: Number(row.longitude) },
        { latitude: Number(row.pin_latitude), longitude: Number(row.pin_longitude) },
      ),
    );
    result.skippedByGate += targets.rows.length - gated.length;

    if (gated.length === 0) {
      continue;
    }

    const distances = await provider.distancesFrom(
      { latitude: Number(office.latitude), longitude: Number(office.longitude) },
      gated.map((row) => ({
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
      })),
    );

    const routed = gated
      .map((row, index) => ({ row, km: distances[index] ?? null }))
      .filter((entry): entry is { row: TargetRow; km: number } => entry.km !== null);

    result.unreachable += gated.length - routed.length;

    for (let i = 0; i < routed.length; i += 200) {
      const chunk = routed.slice(i, i + 200);
      const values: unknown[] = [];
      const tuples = chunk.map((entry, n) => {
        values.push(office.asp_code, entry.row.address_key, Number(entry.km.toFixed(1)));
        return `($${n * 3 + 1}, $${n * 3 + 2}, $${n * 3 + 3})`;
      });

      const written = await query(
        `INSERT INTO office_address_distances (asp_code, address_key, road_km)
         VALUES ${tuples.join(", ")}
         ON CONFLICT (asp_code, address_key) DO UPDATE
           SET road_km = EXCLUDED.road_km,
               provider = EXCLUDED.provider,
               computed_at = NOW()`,
        values,
      );
      result.routed += written.rowCount ?? 0;
    }
  }

  return result;
}
