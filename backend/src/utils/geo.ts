/**
 * Distance and direction between an ASP branch office and a customer pincode.
 *
 * WHY SPHERICAL AND NOT ROAD DISTANCE
 * -----------------------------------
 * Measured against three known road distances from the Maduravoyal office
 * (Anna Nagar 7.6km, Kolathur 12.4km, Red Hills 21km) the straight-line figure
 * runs 1.26-1.62x short, averaging ~1.48. Crucially the ORDER is always
 * preserved, and ordering is what the dispatch decision actually turns on:
 * "which two of these can one engineer do in a morning".
 *
 * ROAD_DETOUR_FACTOR converts to a road-ish estimate so the number on screen is
 * in the same ballpark as what the engineer's phone will say. It is an estimate
 * and `distanceKm` is documented as such; a real routing pass (~217 origin-
 * destination pairs across all five branches) can replace it later without any
 * change to callers.
 */

const EARTH_RADIUS_KM = 6371;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Chennai's measured straight-line-to-road ratio. Applied uniformly; the error
 * is largest on highway runs (Red Hills over-estimates by ~17%) and smallest on
 * dense city routes.
 */
export const ROAD_DETOUR_FACTOR = 1.48;

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** Great-circle distance in kilometres. Accurate to ~0.3% over Tamil Nadu. */
export function haversineKm(from: GeoPoint, to: GeoPoint): number {
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLng = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(deltaLng / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/** Initial bearing in degrees clockwise from true north. */
export function bearingDegrees(from: GeoPoint, to: GeoPoint): number {
  const deltaLng = toRadians(to.longitude - from.longitude);
  const fromLat = toRadians(from.latitude);
  const toLat = toRadians(to.latitude);
  const y = Math.sin(deltaLng) * Math.cos(toLat);
  const x =
    Math.cos(fromLat) * Math.sin(toLat) -
    Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLng);

  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

const COMPASS_SECTORS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

export type CompassSector = (typeof COMPASS_SECTORS)[number];

/**
 * 16-point compass sector. Sixteen rather than eight because eight is too coarse
 * to separate genuinely pairable calls: from Maduravoyal, Anna Nagar (NE) and
 * Kolathur (NNE) sit in adjacent sectors 4.1km apart, while Red Hills (NNW) is
 * a different run entirely.
 */
export function compassSector(degrees: number): CompassSector {
  return COMPASS_SECTORS[Math.round(degrees / 22.5) % 16]!;
}

export interface OfficeDistance {
  /** Road-distance ESTIMATE in km, one decimal. */
  distanceKm: number;
  straightLineKm: number;
  bearing: CompassSector;
}

/**
 * Distance and direction from a branch office to a customer point.
 * Returns null when either end has no coordinate — a blank cell is correct and
 * a guessed one is not.
 */
export function officeDistance(
  office: GeoPoint | null | undefined,
  customer: GeoPoint | null | undefined,
): OfficeDistance | null {
  if (!office || !customer) {
    return null;
  }

  const straightLineKm = haversineKm(office, customer);

  return {
    straightLineKm: Math.round(straightLineKm * 10) / 10,
    distanceKm: Math.round(straightLineKm * ROAD_DETOUR_FACTOR * 10) / 10,
    bearing: compassSector(bearingDegrees(office, customer)),
  };
}

/**
 * The single cell shown in the report: "12.9 km · NNE".
 *
 * Distance and direction share one column deliberately. They are read together
 * (a 12km call NNE and a 12km call SSW are not interchangeable) and the report
 * has a strict column order that is expensive to extend.
 */
export function formatDistanceCell(
  distanceKm: number | null | undefined,
  bearing: string | null | undefined,
  isRouted = true,
): string {
  if (distanceKm == null) {
    return "";
  }

  // A leading tilde marks a straight-line ESTIMATE rather than a routed
  // distance. Measured over the 50 live Chennai pincodes the estimate misses by
  // 5.2km on average, because the real road-to-straight ratio runs 1.11 to 1.94
  // and falls with distance. Rendering it identically to a routed figure would
  // quietly hand the dispatcher a number several kilometres out.
  const km = `${isRouted ? "" : "~"}${distanceKm.toFixed(1)} km`;

  // A distance with no bearing still renders: losing the direction should not
  // also cost the dispatcher the kilometres.
  return bearing ? `${km} \u00b7 ${bearing}` : km;
}

export function formatOfficeDistance(
  distance: OfficeDistance | null | undefined,
): string {
  return distance ? formatDistanceCell(distance.distanceKm, distance.bearing) : "";
}

/**
 * The billing-address trap gate: a provider-geocoded coordinate is only trusted
 * when it lands within this many km of the row's own pincode centroid.
 *
 * The failure it exists for is real and measured: one live row's written
 * address is in Guindy while the service site is Pallipattu, 85 km away — a
 * geocoder answers the ADDRESS, and the address is sometimes a billing office,
 * a head office, or a typo. A pincode area is a few km across, so a coordinate
 * further than this from its own pincode's centre is more likely a wrong-place
 * answer than a right one; the row then keeps the centroid distance, which is
 * at worst ~2 km off rather than 85.
 */
export const PINCODE_SANITY_GATE_KM = 7;

/** True when a geocoded point is plausibly inside its own pincode area. */
export function passesPincodeGate(
  point: GeoPoint,
  pincodeCentroid: GeoPoint,
): boolean {
  return haversineKm(point, pincodeCentroid) <= PINCODE_SANITY_GATE_KM;
}

/**
 * Coarse band used for the records-grid column filter, which matches on exact
 * string values — a continuous kilometre figure would produce one filter entry
 * per pincode and be unusable.
 */
export function distanceBand(distanceKm: number | null | undefined): string {
  if (distanceKm == null) {
    return "";
  }
  if (distanceKm <= 5) return "0-5 km";
  if (distanceKm <= 15) return "5-15 km";
  if (distanceKm <= 30) return "15-30 km";
  return "30+ km";
}
