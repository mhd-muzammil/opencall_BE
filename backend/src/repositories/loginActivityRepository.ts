import { query } from "../config/database.js";

/**
 * Read-only helpers over the existing `user_activity_log` to surface WHERE a principal
 * logged in from (IP address per successful login). Purely additive: no new table, no
 * write — it only reads login events already recorded by the audit logger.
 *
 * A regular user's login carries `actor_user_id`; a special-access login carries the id in
 * `metadata->>'specialAccessId'` (see authController.trySpecialAccessLogin), so the two
 * principal types are queried differently but yield the same LoginPing shape.
 */

export interface LoginPing {
  /** users.id, or special_access.id — depending on the query. */
  principalId: string | null;
  occurredAt: string;
  /** Text form of the INET (host()), or null when not captured. */
  ip: string | null;
  userAgent: string | null;
}

interface LoginPingDb {
  principal_id: string | null;
  occurred_at: string;
  ip: string | null;
  user_agent: string | null;
}

function mapPing(row: LoginPingDb): LoginPing {
  return {
    principalId: row.principal_id,
    occurredAt: row.occurred_at,
    ip: row.ip,
    userAgent: row.user_agent,
  };
}

/** Latest successful login per user (one row each) — for the admin list column. */
export async function getLastLoginsForUsers(): Promise<LoginPing[]> {
  const result = await query<LoginPingDb>(
    `
      SELECT DISTINCT ON (actor_user_id)
        actor_user_id            AS principal_id,
        occurred_at::TEXT        AS occurred_at,
        host(ip_address)         AS ip,
        user_agent
      FROM user_activity_log
      WHERE event_type = 'LOGIN_SUCCESS'
        AND status = 'SUCCESS'
        AND actor_user_id IS NOT NULL
      ORDER BY actor_user_id, occurred_at DESC
    `,
  );
  return result.rows.map(mapPing);
}

/** Recent successful logins for one user, newest first. */
export async function getLoginHistoryForUser(
  userId: string,
  limit: number,
): Promise<LoginPing[]> {
  const result = await query<LoginPingDb>(
    `
      SELECT
        actor_user_id            AS principal_id,
        occurred_at::TEXT        AS occurred_at,
        host(ip_address)         AS ip,
        user_agent
      FROM user_activity_log
      WHERE event_type = 'LOGIN_SUCCESS'
        AND status = 'SUCCESS'
        AND actor_user_id = $1
      ORDER BY occurred_at DESC
      LIMIT $2
    `,
    [userId, limit],
  );
  return result.rows.map(mapPing);
}

/** Latest successful login per special-access login (keyed on metadata.specialAccessId). */
export async function getLastLoginsForSpecialAccess(): Promise<LoginPing[]> {
  const result = await query<LoginPingDb>(
    `
      SELECT DISTINCT ON (metadata->>'specialAccessId')
        metadata->>'specialAccessId' AS principal_id,
        occurred_at::TEXT            AS occurred_at,
        host(ip_address)             AS ip,
        user_agent
      FROM user_activity_log
      WHERE event_type = 'LOGIN_SUCCESS'
        AND status = 'SUCCESS'
        AND metadata->>'specialAccessId' IS NOT NULL
      ORDER BY metadata->>'specialAccessId', occurred_at DESC
    `,
  );
  return result.rows.map(mapPing);
}

/** Recent successful logins for one special-access login, newest first. */
export async function getLoginHistoryForSpecialAccess(
  id: string,
  limit: number,
): Promise<LoginPing[]> {
  const result = await query<LoginPingDb>(
    `
      SELECT
        metadata->>'specialAccessId' AS principal_id,
        occurred_at::TEXT            AS occurred_at,
        host(ip_address)             AS ip,
        user_agent
      FROM user_activity_log
      WHERE event_type = 'LOGIN_SUCCESS'
        AND status = 'SUCCESS'
        AND metadata->>'specialAccessId' = $1
      ORDER BY occurred_at DESC
      LIMIT $2
    `,
    [id, limit],
  );
  return result.rows.map(mapPing);
}
