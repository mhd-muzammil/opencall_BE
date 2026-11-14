/**
 * GPS coordinate -> short street-level label ("Anna Salai, Teynampet, Chennai 600018") for
 * the admin activity-location view. Same contract as ipGeolocationService:
 *   - only runs when an admin opens the view, never on the user's action path;
 *   - never throws — a failed lookup leaves the caller to show raw coordinates;
 *   - cached in-process (coordinates rounded to ~11 m, so one desk = one lookup).
 *
 * Provider: OpenStreetMap Nominatim (free, no key). Its usage policy allows at most one
 * request per second with an identifying User-Agent, so lookups are serialised and each
 * admin request resolves at most MAX_NEW_LOOKUPS_PER_CALL new points; the rest resolve on
 * the next view. Disable with REVERSE_GEOCODE_DISABLED=true.
 */

const ENDPOINT = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "OpenCall-admin-activity/1.0";
const REQUEST_TIMEOUT_MS = 4000;
const MIN_INTERVAL_MS = 1100;
const MAX_NEW_LOOKUPS_PER_CALL = 8;
const SUCCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  label: string | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

export function coordinateKey(lat: number, lon: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

function isDisabled(): boolean {
  return String(process.env.REVERSE_GEOCODE_DISABLED ?? "").toLowerCase() === "true";
}

interface NominatimAddress {
  house_number?: string;
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  village?: string;
  town?: string;
  city?: string;
  county?: string;
  state_district?: string;
  state?: string;
  postcode?: string;
}

export function buildAddressLabel(address: NominatimAddress | undefined): string | null {
  if (!address) return null;
  const street = [address.house_number, address.road].filter(Boolean).join(" ");
  const area = address.neighbourhood ?? address.suburb ?? null;
  const place = address.city ?? address.town ?? address.village ?? address.county ?? null;
  const placeWithPin = [place, address.postcode].filter(Boolean).join(" ");
  const parts = [street, area, placeWithPin].filter((p): p is string => Boolean(p && p.trim()));
  const unique = parts.filter((p, i) => parts.indexOf(p) === i);
  if (unique.length > 0) return unique.join(", ");
  return address.state_district ?? address.state ?? null;
}

async function lookupOne(lat: number, lon: number): Promise<string | null> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();

  const params = new URLSearchParams({
    format: "jsonv2",
    lat: String(lat),
    lon: String(lon),
    zoom: "18",
    addressdetails: "1",
  });
  try {
    const response = await fetch(`${ENDPOINT}?${params.toString()}`, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { address?: NominatimAddress };
    return buildAddressLabel(body.address);
  } catch {
    return null;
  }
}

/**
 * Resolves the given points to labels. Keys of the result are coordinateKey(lat, lon);
 * a point that could not be resolved (yet) is simply absent.
 */
export async function reverseGeocode(
  points: ReadonlyArray<{ lat: number; lon: number }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const now = Date.now();
  const pending: Array<{ key: string; lat: number; lon: number }> = [];

  for (const { lat, lon } of points) {
    const key = coordinateKey(lat, lon);
    if (out.has(key) || pending.some((p) => p.key === key)) continue;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) {
      if (hit.label) out.set(key, hit.label);
      continue;
    }
    pending.push({ key, lat, lon });
  }

  if (isDisabled() || pending.length === 0) return out;

  // Serialise across concurrent admin requests so the 1 req/s limit holds process-wide.
  const run = queue.then(async () => {
    for (const point of pending.slice(0, MAX_NEW_LOOKUPS_PER_CALL)) {
      const label = await lookupOne(point.lat, point.lon);
      cache.set(point.key, {
        label,
        expiresAt: Date.now() + (label ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
      });
      if (label) out.set(point.key, label);
    }
  });
  queue = run.catch(() => undefined);
  await run.catch(() => undefined);
  return out;
}
