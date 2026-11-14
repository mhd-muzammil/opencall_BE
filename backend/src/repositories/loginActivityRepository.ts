import { query } from "../config/database.js";
import type { ActivityEventType } from "./activityLogRepository.js";
import type { ClientLocation } from "../services/audit/clientLocation.js";

/**
 * Read-only helpers over the existing `user_activity_log` to surface WHERE a principal has
 * been active from (IP per action) and WHEN they were last seen. Purely additive: no new
 * table, no write — it only reads events already recorded by the audit logger.
 *
 * Covers ALL successful activity (login, report edits, uploads, …), not just logins, so the
 * admin sees a "last seen" location for each principal. A regular user's action carries
 * `actor_user_id`; a special-access action carries the id in `metadata->>'specialAccessId'`
 * (both the login AND edit paths set it), so the two principal types are queried differently
 * but yield the same ActivityPing shape.
 */

export interface ActivityPing {
  /** users.id, or special_access.id — depending on the query. */
  principalId: string | null;
  occurredAt: string;
  eventType: ActivityEventType;
  /** Text form of the INET (host()), or null when not captured. */
  ip: string | null;
  userAgent: string | null;
  /** The browser's GPS fix (or why there is none), when the client sent one. */
  clientLocation: ClientLocation | null;
  /** For case edits: which ticket, and the RTPL status move if the status changed. */
  ticketId: string | null;
  rtplStatusChange: { fromStatus: string | null; toStatus: string | null } | null;
}

interface ActivityPingDb {
  principal_id: string | null;
  occurred_at: string;
  event_type: ActivityEventType;
  ip: string | null;
  user_agent: string | null;
  client_location: unknown;
  ticket_id: string | null;
  rtpl_status_change: unknown;
}

/** Re-validates the stored JSON — older rows and hand-edited metadata must not break the view. */
function toClientLocation(value: unknown): ClientLocation | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.status === "denied" || v.status === "unavailable") return { status: v.status };
  if (
    v.status === "ok" &&
    typeof v.lat === "number" &&
    typeof v.lon === "number" &&
    typeof v.accuracyM === "number" &&
    typeof v.capturedAt === "string"
  ) {
    return {
      status: "ok",
      lat: v.lat,
      lon: v.lon,
      accuracyM: v.accuracyM,
      capturedAt: v.capturedAt,
    };
  }
  return null;
}

function toStatusChange(value: unknown): ActivityPing["rtplStatusChange"] {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  return { fromStatus: str(v.fromStatus), toStatus: str(v.toStatus) };
}

function mapPing(row: ActivityPingDb): ActivityPing {
  return {
    principalId: row.principal_id,
    occurredAt: row.occurred_at,
    eventType: row.event_type,
    ip: row.ip,
    userAgent: row.user_agent,
    clientLocation: toClientLocation(row.client_location),
    ticketId: row.ticket_id,
    rtplStatusChange: toStatusChange(row.rtpl_status_change),
  };
}

/** Most recent successful action per user (one row each) — for the admin list column. */
export async function getLastActivityForUsers(): Promise<ActivityPing[]> {
  const result = await query<ActivityPingDb>(
    `
      SELECT DISTINCT ON (actor_user_id)
        actor_user_id            AS principal_id,
        occurred_at::TEXT        AS occurred_at,
        event_type,
        host(ip_address)         AS ip,
        user_agent,
        metadata->'clientLocation'   AS client_location,
        metadata->>'ticketId'        AS ticket_id,
        metadata->'rtplStatusChange' AS rtpl_status_change
      FROM user_activity_log
      WHERE status = 'SUCCESS'
        AND actor_user_id IS NOT NULL
      ORDER BY actor_user_id, occurred_at DESC
    `,
  );
  return result.rows.map(mapPing);
}

/** Recent successful actions for one user, newest first. */
export async function getActivityHistoryForUser(
  userId: string,
  limit: number,
): Promise<ActivityPing[]> {
  const result = await query<ActivityPingDb>(
    `
      SELECT
        actor_user_id            AS principal_id,
        occurred_at::TEXT        AS occurred_at,
        event_type,
        host(ip_address)         AS ip,
        user_agent,
        metadata->'clientLocation'   AS client_location,
        metadata->>'ticketId'        AS ticket_id,
        metadata->'rtplStatusChange' AS rtpl_status_change
      FROM user_activity_log
      WHERE status = 'SUCCESS'
        AND actor_user_id = $1
      ORDER BY occurred_at DESC
      LIMIT $2
    `,
    [userId, limit],
  );
  return result.rows.map(mapPing);
}

/** Most recent successful action per special-access login (keyed on metadata.specialAccessId). */
export async function getLastActivityForSpecialAccess(): Promise<ActivityPing[]> {
  const result = await query<ActivityPingDb>(
    `
      SELECT DISTINCT ON (metadata->>'specialAccessId')
        metadata->>'specialAccessId' AS principal_id,
        occurred_at::TEXT            AS occurred_at,
        event_type,
        host(ip_address)             AS ip,
        user_agent,
        metadata->'clientLocation'   AS client_location,
        metadata->>'ticketId'        AS ticket_id,
        metadata->'rtplStatusChange' AS rtpl_status_change
      FROM user_activity_log
      WHERE status = 'SUCCESS'
        AND metadata->>'specialAccessId' IS NOT NULL
      ORDER BY metadata->>'specialAccessId', occurred_at DESC
    `,
  );
  return result.rows.map(mapPing);
}

/** Recent successful actions for one special-access login, newest first. */
export async function getActivityHistoryForSpecialAccess(
  id: string,
  limit: number,
): Promise<ActivityPing[]> {
  const result = await query<ActivityPingDb>(
    `
      SELECT
        metadata->>'specialAccessId' AS principal_id,
        occurred_at::TEXT            AS occurred_at,
        event_type,
        host(ip_address)             AS ip,
        user_agent,
        metadata->'clientLocation'   AS client_location,
        metadata->>'ticketId'        AS ticket_id,
        metadata->'rtplStatusChange' AS rtpl_status_change
      FROM user_activity_log
      WHERE status = 'SUCCESS'
        AND metadata->>'specialAccessId' = $1
      ORDER BY occurred_at DESC
      LIMIT $2
    `,
    [id, limit],
  );
  return result.rows.map(mapPing);
}
