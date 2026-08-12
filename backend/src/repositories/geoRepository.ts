import type { PoolClient } from "pg";
import type { GeoPoint } from "../utils/geo.js";
import { normalizePincode } from "../services/normalization/valueNormalizer.js";

interface RegionOfficeRow {
  asp_code: string;
  label: string;
  latitude: string;
  longitude: string;
}

interface PincodeGeoRow {
  pincode: string;
  latitude: string;
  longitude: string;
}

export interface RegionOffice extends GeoPoint {
  aspCode: string;
  label: string;
}

/**
 * Branch office coordinates, keyed by the ASP work-location code that report
 * rows already carry.
 *
 * Only branches somebody has actually surveyed appear here. A missing branch is
 * not an error — it yields a blank Distance cell for that region, which is the
 * correct outcome until real coordinates are supplied.
 */
export async function findRegionOfficesByAspCode(
  client: PoolClient,
): Promise<Map<string, RegionOffice>> {
  const result = await client.query<RegionOfficeRow>(
    `SELECT asp_code, label, latitude, longitude FROM region_offices`,
  );

  return new Map(
    result.rows.map((row) => [
      row.asp_code.trim().toUpperCase(),
      {
        aspCode: row.asp_code.trim().toUpperCase(),
        label: row.label,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
      },
    ]),
  );
}

/**
 * Pincode centroids for the whole country.
 *
 * Loaded in full rather than filtered by region because it is a small table
 * (~19k rows nationally, ~2k for Tamil Nadu) and because calls regularly sit
 * outside their branch's home district — a Chennai work order at a Vellore
 * address still needs its true distance so the misfiling is visible instead of
 * hidden behind a blank cell.
 */
export async function findPincodeCoordinates(
  client: PoolClient,
): Promise<Map<string, GeoPoint>> {
  const result = await client.query<PincodeGeoRow>(
    `SELECT pincode, latitude, longitude FROM pincode_geo`,
  );

  return new Map(
    result.rows.map((row) => [
      normalizePincode(row.pincode) ?? row.pincode,
      { latitude: Number(row.latitude), longitude: Number(row.longitude) },
    ]),
  );
}

interface RoadDistanceRow {
  asp_code: string;
  pincode: string;
  road_km: string;
}

/** Key for the routed-distance map: one branch office against one pincode. */
export function roadDistanceKey(aspCode: string, pincode: string): string {
  return `${aspCode.trim().toUpperCase()}|${pincode}`;
}

/**
 * Routed road distances, keyed by office+pincode.
 *
 * A missing entry is normal, not an error: the row falls back to the
 * straight-line estimate, which the report marks with a leading tilde so nobody
 * mistakes an approximation for a measurement.
 */
export async function findRoadDistances(
  client: PoolClient,
): Promise<Map<string, number>> {
  const result = await client.query<RoadDistanceRow>(
    `SELECT asp_code, pincode, road_km FROM office_pincode_distances`,
  );

  return new Map(
    result.rows.map((row) => [
      roadDistanceKey(row.asp_code, row.pincode),
      Number(row.road_km),
    ]),
  );
}
