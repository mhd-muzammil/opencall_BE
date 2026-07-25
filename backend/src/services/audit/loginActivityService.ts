import {
  getLastLoginsForSpecialAccess,
  getLastLoginsForUsers,
  getLoginHistoryForSpecialAccess,
  getLoginHistoryForUser,
  type LoginPing,
} from "../../repositories/loginActivityRepository.js";
import { resolveIps, type GeoLocation } from "./ipGeolocationService.js";

/**
 * Ties the login events (WHO logged in, WHEN, from which IP) to a resolved place. Feeds the
 * admin "Last location" column + per-principal history. Admin-only surface; nothing here is
 * ever exposed to the principal being observed.
 */

const HISTORY_LIMIT = 50;

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
  lastLoginAt: string;
  ip: string | null;
  location: LoginLocationInfo | null;
}

export interface LoginLocationEntry {
  occurredAt: string;
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
  pings: LoginPing[],
  geoByIp: Map<string, GeoLocation>,
): LoginLocationSummaryItem[] {
  const items: LoginLocationSummaryItem[] = [];
  for (const p of pings) {
    if (!p.principalId) continue;
    items.push({
      principalId: p.principalId,
      lastLoginAt: p.occurredAt,
      ip: p.ip,
      location: p.ip ? toInfo(geoByIp.get(p.ip)) : null,
    });
  }
  return items;
}

function toHistory(
  pings: LoginPing[],
  geoByIp: Map<string, GeoLocation>,
): LoginLocationEntry[] {
  return pings.map((p) => ({
    occurredAt: p.occurredAt,
    ip: p.ip,
    userAgent: p.userAgent,
    location: p.ip ? toInfo(geoByIp.get(p.ip)) : null,
  }));
}

export async function getUserLoginSummary(): Promise<LoginLocationSummaryItem[]> {
  const pings = await getLastLoginsForUsers();
  const geoByIp = await resolveIps(pings.map((p) => p.ip));
  return toSummary(pings, geoByIp);
}

export async function getUserLoginHistory(userId: string): Promise<LoginLocationEntry[]> {
  const pings = await getLoginHistoryForUser(userId, HISTORY_LIMIT);
  const geoByIp = await resolveIps(pings.map((p) => p.ip));
  return toHistory(pings, geoByIp);
}

export async function getSpecialAccessLoginSummary(): Promise<LoginLocationSummaryItem[]> {
  const pings = await getLastLoginsForSpecialAccess();
  const geoByIp = await resolveIps(pings.map((p) => p.ip));
  return toSummary(pings, geoByIp);
}

export async function getSpecialAccessLoginHistory(
  id: string,
): Promise<LoginLocationEntry[]> {
  const pings = await getLoginHistoryForSpecialAccess(id, HISTORY_LIMIT);
  const geoByIp = await resolveIps(pings.map((p) => p.ip));
  return toHistory(pings, geoByIp);
}
