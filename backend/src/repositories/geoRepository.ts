import type { PoolClient } from "pg";
import type { GeoPoint } from "../utils/geo.js";
import type { PreciseWorkOrderCoordinate } from "../types/matching.js";
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

/** Key for the per-address routed-distance map: one branch office against one cached address. */
export function addressRoadDistanceKey(aspCode: string, addressKey: string): string {
  return `${aspCode.trim().toUpperCase()}|${addressKey}`;
}

/**
 * Provider-geocoded coordinates per work order — the exact-address tier.
 *
 * Only source='provider' rows qualify: the centroid rows in the same table are
 * exactly what the pincode tier already computes, so loading them would say
 * nothing new. The sanity gate against the row's own pincode centroid is NOT
 * applied here but in the matching engine, next to the centroid map it needs —
 * one implementation, unit-testable without a database.
 *
 * Tolerates the table not existing (a push deploys BEFORE its migration can
 * run — the 2026-08-06 lesson): the map is empty and every row keeps its
 * pincode distance, which is exactly the pre-geocoding behaviour.
 */
export async function findPreciseWorkOrderCoordinates(
  client: PoolClient,
): Promise<Map<string, PreciseWorkOrderCoordinate>> {
  try {
    const result = await client.query<{
      normalized_ticket_id: string;
      address_key: string;
      latitude: string;
      longitude: string;
    }>(
      `SELECT normalized_ticket_id, address_key, latitude, longitude
         FROM work_order_geocodes
        WHERE source = 'provider'
          AND address_key IS NOT NULL
          AND latitude IS NOT NULL
          AND longitude IS NOT NULL`,
    );

    return new Map(
      result.rows.map((row) => [
        row.normalized_ticket_id,
        {
          latitude: Number(row.latitude),
          longitude: Number(row.longitude),
          addressKey: row.address_key,
        },
      ]),
    );
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") {
      return new Map();
    }
    throw error;
  }
}

/**
 * Routed road distances per (office, geocoded address) — the precise tier's
 * counterpart of `findRoadDistances`. Same missing-table tolerance as above:
 * migration 055 lands only after the code that reads it has deployed.
 */
export async function findAddressRoadDistances(
  client: PoolClient,
): Promise<Map<string, number>> {
  try {
    const result = await client.query<{
      asp_code: string;
      address_key: string;
      road_km: string;
    }>(
      `SELECT asp_code, address_key, road_km FROM office_address_distances`,
    );

    return new Map(
      result.rows.map((row) => [
        addressRoadDistanceKey(row.asp_code, row.address_key),
        Number(row.road_km),
      ]),
    );
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") {
      return new Map();
    }
    throw error;
  }
}
