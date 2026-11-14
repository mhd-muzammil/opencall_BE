import {
  getActivityHistoryForSpecialAccess,
  getActivityHistoryForUser,
  getLastActivityForSpecialAccess,
  getLastActivityForUsers,
  type ActivityPing,
} from "../../repositories/loginActivityRepository.js";
import type { ActivityEventType } from "../../repositories/activityLogRepository.js";
import { resolveIps, type GeoLocation } from "./ipGeolocationService.js";
import { coordinateKey, reverseGeocode } from "./reverseGeocodeService.js";

/**
 * Ties activity events (WHO did WHAT, WHEN, from WHERE) to a place. Feeds the admin
 * "Last seen" column + per-principal history — covering all activity, not just logins.
 * Admin-only surface; nothing here is ever exposed to the principal being observed.
 *
 * WHERE prefers the browser's own GPS/Wi-Fi fix (street-level, carries an accuracy radius)
 * and falls back to IP geolocation (city-level at best, often the ISP's hub city), with
 * `source` telling the UI which one it is looking at.
 */

const HISTORY_LIMIT = 100;

export type LocationSource = "gps" | "ip";
/** What the browser said about its position: shared, refused, or no fresh fix. */
export type GpsStatus = "ok" | "denied" | "unavailable" | null;

export interface LoginLocationInfo {
  source: LocationSource;
  label: string;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  isp: string | null;
  lat: number | null;
  lon: number | null;
  isPrivate: boolean;
  /** GPS only: accuracy radius in metres reported by the device. */
  accuracyM: number | null;
  /** GPS only: when the device took the fix. */
  capturedAt: string | null;
}

interface ActionDetail {
  gpsStatus: GpsStatus;
  ticketId: string | null;
  statusChange: { fromStatus: string | null; toStatus: string | null } | null;
}

export interface LoginLocationSummaryItem extends ActionDetail {
  principalId: string;
  lastSeenAt: string;
  eventType: ActivityEventType;
  ip: string | null;
  location: LoginLocationInfo | null;
}

export interface LoginLocationEntry extends ActionDetail {
  occurredAt: string;
  eventType: ActivityEventType;
  ip: string | null;
  userAgent: string | null;
  location: LoginLocationInfo | null;
}

interface Resolved {
  geoByIp: Map<string, GeoLocation>;
  addressByPoint: Map<string, string>;
}

async function resolvePlaces(pings: ActivityPing[]): Promise<Resolved> {
  const gpsPoints = pings.flatMap((p) =>
    p.clientLocation?.status === "ok" ? [{ lat: p.clientLocation.lat, lon: p.clientLocation.lon }] : [],
  );
  // IP lookups are only needed for actions with no GPS fix.
  const ipsNeeded = pings.filter((p) => p.clientLocation?.status !== "ok").map((p) => p.ip);
  const [geoByIp, addressByPoint] = await Promise.all([
    resolveIps(ipsNeeded),
    reverseGeocode(gpsPoints),
  ]);
  return { geoByIp, addressByPoint };
}

function ipInfo(geo: GeoLocation | undefined): LoginLocationInfo | null {
  if (!geo) return null;
  return {
    source: "ip",
    label: geo.label,
    city: geo.city,
    region: geo.region,
    country: geo.country,
    countryCode: geo.countryCode,
    isp: geo.isp,
    lat: geo.lat,
    lon: geo.lon,
    isPrivate: geo.isPrivate,
    accuracyM: null,
    capturedAt: null,
  };
}

function locationFor(p: ActivityPing, resolved: Resolved): LoginLocationInfo | null {
  const gps = p.clientLocation;
  if (gps?.status === "ok") {
    const address = resolved.addressByPoint.get(coordinateKey(gps.lat, gps.lon));
    return {
      source: "gps",
      label: address ?? `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}`,
      city: null,
      region: null,
      country: null,
      countryCode: null,
      isp: null,
      lat: gps.lat,
      lon: gps.lon,
      isPrivate: false,
      accuracyM: gps.accuracyM,
      capturedAt: gps.capturedAt,
    };
  }
  return p.ip ? ipInfo(resolved.geoByIp.get(p.ip)) : null;
}

function detailFor(p: ActivityPing): ActionDetail {
  return {
    gpsStatus: p.clientLocation?.status ?? null,
    ticketId: p.ticketId,
    statusChange: p.rtplStatusChange,
  };
}

function toSummary(pings: ActivityPing[], resolved: Resolved): LoginLocationSummaryItem[] {
  const items: LoginLocationSummaryItem[] = [];
  for (const p of pings) {
    if (!p.principalId) continue;
    items.push({
      principalId: p.principalId,
      lastSeenAt: p.occurredAt,
      eventType: p.eventType,
      ip: p.ip,
      location: locationFor(p, resolved),
      ...detailFor(p),
    });
  }
  return items;
}

function toHistory(pings: ActivityPing[], resolved: Resolved): LoginLocationEntry[] {
  return pings.map((p) => ({
    occurredAt: p.occurredAt,
    eventType: p.eventType,
    ip: p.ip,
    userAgent: p.userAgent,
    location: locationFor(p, resolved),
    ...detailFor(p),
  }));
}

export async function getUserLoginSummary(): Promise<LoginLocationSummaryItem[]> {
  const pings = await getLastActivityForUsers();
  return toSummary(pings, await resolvePlaces(pings));
}

export async function getUserLoginHistory(userId: string): Promise<LoginLocationEntry[]> {
  const pings = await getActivityHistoryForUser(userId, HISTORY_LIMIT);
  return toHistory(pings, await resolvePlaces(pings));
}

export async function getSpecialAccessLoginSummary(): Promise<LoginLocationSummaryItem[]> {
  const pings = await getLastActivityForSpecialAccess();
  return toSummary(pings, await resolvePlaces(pings));
}

export async function getSpecialAccessLoginHistory(
  id: string,
): Promise<LoginLocationEntry[]> {
  const pings = await getActivityHistoryForSpecialAccess(id, HISTORY_LIMIT);
  return toHistory(pings, await resolvePlaces(pings));
}
