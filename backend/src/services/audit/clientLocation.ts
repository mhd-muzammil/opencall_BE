/**
 * The browser's own GPS / Wi-Fi fix, sent by the web app on every API call as
 *   X-Client-Location: <lat>,<lon>,<accuracyMetres>,<capturedAtEpochMs>
 * or, when the user has not shared a position,
 *   X-Client-Location: denied | unavailable
 *
 * IP geolocation only ever knows the ISP's city (Indian mobile/broadband IPs routinely
 * resolve to a hub hundreds of km away), so this is what makes the admin "location"
 * column trustworthy. It is stored inside the activity row's metadata — no schema change.
 *
 * The header is client-supplied, so it is evidence, not proof: a user can spoof it with
 * dev tools. It is validated for shape and freshness only.
 */

export type ClientLocation =
  | {
      status: "ok";
      lat: number;
      lon: number;
      /** Radius of the 68% confidence circle the browser reported, in metres. */
      accuracyM: number;
      /** When the device took the fix (ISO). */
      capturedAt: string;
    }
  | { status: "denied" | "unavailable" };

/** A fix older than this at the time of the action says where they WERE, not where they are. */
const MAX_FIX_AGE_MS = 15 * 60 * 1000;
/** Tolerate a little device clock skew into the future. */
const MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;
const MAX_ACCURACY_M = 100_000;

export const CLIENT_LOCATION_HEADER = "x-client-location";

export function parseClientLocationHeader(
  value: string | null | undefined,
  now: number = Date.now(),
): ClientLocation | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "denied" || raw === "unavailable") return { status: raw };

  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length !== 4) return null;
  const [lat, lon, accuracy, capturedAtMs] = parts.map(Number) as [
    number,
    number,
    number,
    number,
  ];

  if (![lat, lon, accuracy, capturedAtMs].every(Number.isFinite)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (accuracy < 0 || accuracy > MAX_ACCURACY_M) return null;
  // A stale fix is reported as "unavailable" rather than dropped, so the admin can tell
  // "had location switched on but no fresh fix" apart from "never sent anything".
  if (capturedAtMs > now + MAX_FUTURE_SKEW_MS || now - capturedAtMs > MAX_FIX_AGE_MS) {
    return { status: "unavailable" };
  }

  return {
    status: "ok",
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    accuracyM: Math.round(accuracy),
    capturedAt: new Date(capturedAtMs).toISOString(),
  };
}
