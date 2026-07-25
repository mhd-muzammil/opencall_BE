import {
  getActivityHistoryForSpecialAccess,
  getActivityHistoryForUser,
  getLastActivityForSpecialAccess,
  getLastActivityForUsers,
  type ActivityPing,
} from "../../repositories/loginActivityRepository.js";
import type { ActivityEventType } from "../../repositories/activityLogRepository.js";
import { resolveIps, type GeoLocation } from "./ipGeolocationService.js";

/**
 * Ties activity events (WHO did WHAT, WHEN, from which IP) to a resolved place. Feeds the
 * admin "Last seen" column + per-principal history — covering all activity, not just logins.
 * Admin-only surface; nothing here is ever exposed to the principal being observed.
 */

const HISTORY_LIMIT = 100;

export interface LoginLocationInfo {
  label: string;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  isp: string | null;
  lat: number | null;
  lon: number | null;
  isPrivate: boolean;
}

export interface LoginLocationSummaryItem {
  principalId: string;
  lastSeenAt: string;
  eventType: ActivityEventType;
  ip: string | null;
  location: LoginLocationInfo | null;
}

export interface LoginLocationEntry {
  occurredAt: string;
  eventType: ActivityEventType;
  ip: string | null;
  userAgent: string | null;
  location: LoginLocationInfo | null;
}

function toInfo(geo: GeoLocation | undefined): LoginLocationInfo | null {
  if (!geo) return null;
  return {
    label: geo.label,
    city: geo.city,
    region: geo.region,
    country: geo.country,
    countryCode: geo.countryCode,
    isp: geo.isp,
    lat: geo.lat,
    lon: geo.lon,
    isPrivate: geo.isPrivate,
  };
}

function toSummary(
  pings: ActivityPing[],
  geoByIp: Map<string, GeoLocation>,
): LoginLocationSummaryItem[] {
  const items: LoginLocationSummaryItem[] = [];
  for (const p of pings) {
    if (!p.principalId) continue;
    items.push({
      principalId: p.principalId,
      lastSeenAt: p.occurredAt,
      eventType: p.eventType,
      ip: p.ip,
      location: p.ip ? toInfo(geoByIp.get(p.ip)) : null,
    });
  }
  return items;
}

function toHistory(
  pings: ActivityPing[],
  geoByIp: Map<string, GeoLocation>,
): LoginLocationEntry[] {
  return pings.map((p) => ({
    occurredAt: p.occurredAt,
    eventType: p.eventType,
    ip: p.ip,
    userAgent: p.userAgent,
    location: p.ip ? toInfo(geoByIp.get(p.ip)) : null,
  }));
}

export async function getUserLoginSummary(): Promise<LoginLocationSummaryItem[]> {
  const pings = await getLastActivityForUsers();
  const geoByIp = await resolveIps(pings.map((p) => p.ip));
  return toSummary(pings, geoByIp);
}

export async function getUserLoginHistory(userId: string): Promise<LoginLocationEntry[]> {
  const pings = await getActivityHistoryForUser(userId, HISTORY_LIMIT);
  const geoByIp = await resolveIps(pings.map((p) => p.ip));
  return toHistory(pings, geoByIp);
}

export async function getSpecialAccessLoginSummary(): Promise<LoginLocationSummaryItem[]> {
  const pings = await getLastActivityForSpecialAccess();
  const geoByIp = await resolveIps(pings.map((p) => p.ip));
  return toSummary(pings, geoByIp);
}

export async function getSpecialAccessLoginHistory(
  id: string,
): Promise<LoginLocationEntry[]> {
  const pings = await getActivityHistoryForSpecialAccess(id, HISTORY_LIMIT);
  const geoByIp = await resolveIps(pings.map((p) => p.ip));
  return toHistory(pings, geoByIp);
}
