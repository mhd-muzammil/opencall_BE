import { query, withTransaction } from "../config/database.js";

interface UserRegionRow {
  region_id: string;
}

/**
 * Additional regions a user may manage, beyond their primary users.region_id.
 * Rows live in user_regions (see migration 025_user_regions.sql).
 */
export async function findAdditionalRegionIdsForUser(
  userId: string,
): Promise<string[]> {
  const result = await query<UserRegionRow>(
    `
      SELECT region_id
      FROM user_regions
      WHERE user_id = $1
      ORDER BY created_at ASC, region_id ASC
    `,
    [userId],
  );
  return result.rows.map((row) => row.region_id);
}

/**
 * Replaces the user's additional regions with the given set (delete-then-insert
 * in a single transaction). Pass an empty array to clear all additional regions.
 */
export async function setAdditionalUserRegions(
  userId: string,
  regionIds: string[],
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM user_regions WHERE user_id = $1`, [userId]);
    for (const regionId of regionIds) {
      await client.query(
        `
          INSERT INTO user_regions (user_id, region_id)
          VALUES ($1, $2)
          ON CONFLICT (user_id, region_id) DO NOTHING
        `,
        [userId, regionId],
      );
    }
  });
}
