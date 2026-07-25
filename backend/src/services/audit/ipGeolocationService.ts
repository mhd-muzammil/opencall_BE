/**
 * Resolves IP addresses to an approximate place (city / region / country) for the admin
 * login-location view. Design constraints:
 *   - NEVER touches the login path — resolution happens only when an admin opens the view.
 *   - Resilient: any lookup failure (offline, rate-limited, timeout) degrades to "IP only",
 *     never throws into the caller.
 *   - Cached in-process so repeated admin views don't re-hit the lookup service. Distinct
 *     login IPs are few, so an in-memory Map is plenty and adds ZERO schema/DB surface.
 *   - Private / LAN / loopback IPs are labelled locally without any outbound call.
 *
 * Lookup provider: ip-api.com batch endpoint (free, no key, up to 100 IPs/request). Can be
 * disabled with IP_GEO_LOOKUP_DISABLED=true (then everything degrades to "IP only").
 */

export interface GeoLocation {
  ip: string;
  isPrivate: boolean;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  isp: string | null;
  /** Approximate coordinates (city-level) for pinning on a map; null when unknown. */
  lat: number | null;
  lon: number | null;
  /** Human-readable place label, always set (falls back to "Unknown location"). */
  label: string;
}

interface CacheEntry {
  geo: GeoLocation;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // resolved places rarely change
const FAILURE_TTL_MS = 30 * 60 * 1000; // retry unknowns after 30 min
const BATCH_URL = "http://ip-api.com/batch?fields=status,message,country,countryCode,regionName,city,lat,lon,isp,query";
const BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MS = 4000;

function isLookupDisabled(): boolean {
  return String(process.env.IP_GEO_LOOKUP_DISABLED ?? "").toLowerCase() === "true";
}

/** True for loopback / LAN / link-local / CGNAT addresses — no point calling out for these. */
function isPrivateIp(ip: string): boolean {
  const raw = ip.trim().toLowerCase();
  if (!raw) return true;
  // Normalise IPv4-mapped IPv6 (::ffff:192.168.0.1) down to the IPv4 part.
  const v4 = raw.startsWith("::ffff:") ? raw.slice(7) : raw;

  if (v4 === "127.0.0.1" || raw === "::1" || raw === "localhost") return true;
  if (raw.startsWith("fe80:") || raw.startsWith("fc") || raw.startsWith("fd")) return true;

  const parts = v4.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const [a, b] = parts.map((p) => Number(p)) as [number, number, number, number];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 0) return true;
  }
  return false;
}

function buildLabel(parts: {
  isPrivate: boolean;
  city: string | null;
  region: string | null;
  country: string | null;
}): string {
  if (parts.isPrivate) return "Local / Private network";
  const pieces = [parts.city, parts.region, parts.country].filter(
    (p): p is string => Boolean(p && p.trim()),
  );
  return pieces.length ? pieces.join(", ") : "Unknown location";
}

function privateGeo(ip: string): GeoLocation {
  return {
    ip,
    isPrivate: true,
    city: null,
    region: null,
    country: null,
    countryCode: null,
    isp: null,
    lat: null,
    lon: null,
    label: buildLabel({ isPrivate: true, city: null, region: null, country: null }),
  };
}

function unknownGeo(ip: string): GeoLocation {
  return {
    ip,
    isPrivate: false,
    city: null,
    region: null,
    country: null,
    countryCode: null,
    isp: null,
    lat: null,
    lon: null,
    label: "Unknown location",
  };
}

interface IpApiResult {
  status?: string;
  message?: string;
  country?: string;
  countryCode?: string;
  regionName?: string;
  city?: string;
  lat?: number;
  lon?: number;
  isp?: string;
  query?: string;
}

/**
 * The audit log can store an IPv4-mapped IPv6 form (e.g. "::ffff:103.42.18.7") when the
 * socket is dual-stack. ip-api resolves the plain IPv4, so strip the mapping prefix before
 * looking up. Non-mapped values pass through unchanged.
 */
function normalizeForLookup(ip: string): string {
  const raw = ip.trim();
  if (raw.toLowerCase().startsWith("::ffff:")) {
    const rest = raw.slice(7);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return rest;
  }
  return raw;
}

/** Looks up a set of IPs. Keys the returned map by the ORIGINAL (un-normalized) IP string. */
async function lookupBatch(ips: string[]): Promise<Map<string, GeoLocation>> {
  const out = new Map<string, GeoLocation>();
  // query IP (normalized) -> original IP(s) as passed in
  const queryToOriginals = new Map<string, string[]>();
  for (const original of ips) {
    const q = normalizeForLookup(original);
    const list = queryToOriginals.get(q);
    if (list) list.push(original);
    else queryToOriginals.set(q, [original]);
  }
  const queryIps = [...queryToOriginals.keys()];

  let response: Response;
  try {
    response = await fetch(BATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(queryIps),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return out; // offline / timeout — caller falls back to unknown
  }
  if (!response.ok) return out;

  let payload: IpApiResult[];
  try {
    payload = (await response.json()) as IpApiResult[];
  } catch {
    return out;
  }
  if (!Array.isArray(payload)) return out;

  for (const item of payload) {
    const queryIp = String(item.query ?? "").trim();
    if (!queryIp) continue;
    const originals = queryToOriginals.get(queryIp) ?? [queryIp];
    if (item.status === "success") {
      const city = item.city?.trim() || null;
      const region = item.regionName?.trim() || null;
      const country = item.country?.trim() || null;
      const countryCode = item.countryCode?.trim() || null;
      const isp = item.isp?.trim() || null;
      const lat = typeof item.lat === "number" ? item.lat : null;
      const lon = typeof item.lon === "number" ? item.lon : null;
      const label = buildLabel({ isPrivate: false, city, region, country });
      for (const original of originals) {
        out.set(original, {
          ip: original,
          isPrivate: false,
          city,
          region,
          country,
          countryCode,
          isp,
          lat,
          lon,
          label,
        });
      }
    } else {
      for (const original of originals) {
        out.set(original, unknownGeo(original));
      }
    }
  }
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Resolves a set of IPs to places. Returns a map keyed by the exact IP string passed in.
 * Never throws — unresolvable IPs come back labelled "Unknown location".
 */
export async function resolveIps(ips: readonly (string | null)[]): Promise<Map<string, GeoLocation>> {
  const now = Date.now();
  const result = new Map<string, GeoLocation>();
  const unique = new Set<string>();
  for (const ip of ips) {
    const trimmed = ip?.trim();
    if (trimmed) unique.add(trimmed);
  }

  const toLookup: string[] = [];
  for (const ip of unique) {
    const cached = cache.get(ip);
    if (cached && cached.expiresAt > now) {
      result.set(ip, cached.geo);
      continue;
    }
    if (isPrivateIp(ip)) {
      const geo = privateGeo(ip);
      cache.set(ip, { geo, expiresAt: now + SUCCESS_TTL_MS });
      result.set(ip, geo);
      continue;
    }
    toLookup.push(ip);
  }

  if (toLookup.length > 0 && !isLookupDisabled()) {
    for (const batch of chunk(toLookup, BATCH_SIZE)) {
      const resolved = await lookupBatch(batch);
      for (const ip of batch) {
        const geo = resolved.get(ip) ?? unknownGeo(ip);
        const ttl = geo.label === "Unknown location" ? FAILURE_TTL_MS : SUCCESS_TTL_MS;
        cache.set(ip, { geo, expiresAt: now + ttl });
        result.set(ip, geo);
      }
    }
  } else {
    // Lookup disabled (or nothing to look up) — remaining public IPs stay unknown.
    for (const ip of toLookup) {
      const geo = unknownGeo(ip);
      result.set(ip, geo);
    }
  }

  return result;
}
