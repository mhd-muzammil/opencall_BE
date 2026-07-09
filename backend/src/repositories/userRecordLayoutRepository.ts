import { query } from "../config/database.js";

export interface UserRecordLayout {
  orderedColumns: string[];
  updatedAt: string;
}

interface UserRecordLayoutDbRow {
  ordered_columns: string[];
  updated_at: string;
}

/**
 * Returns the user's saved records-grid column layout, or null when they have
 * not customised it (the frontend then falls back to the default full layout).
 */
export async function findUserRecordLayout(
  userId: string,
): Promise<UserRecordLayout | null> {
  const result = await query<UserRecordLayoutDbRow>(
    `
      SELECT ordered_columns, updated_at::TEXT AS updated_at
      FROM user_record_layouts
      WHERE user_id = $1
    `,
    [userId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return { orderedColumns: row.ordered_columns, updatedAt: row.updated_at };
}

export async function upsertUserRecordLayout(input: {
  userId: string;
  orderedColumns: readonly string[];
}): Promise<UserRecordLayout> {
  const result = await query<UserRecordLayoutDbRow>(
    `
      INSERT INTO user_record_layouts (user_id, ordered_columns, updated_by, updated_at)
      VALUES ($1, $2::jsonb, $1, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET ordered_columns = EXCLUDED.ordered_columns,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
      RETURNING ordered_columns, updated_at::TEXT AS updated_at
    `,
    [input.userId, JSON.stringify(input.orderedColumns)],
  );

  const row = result.rows[0]!;
  return { orderedColumns: row.ordered_columns, updatedAt: row.updated_at };
}

/** Removes the user's custom layout, reverting them to the default. */
export async function deleteUserRecordLayout(userId: string): Promise<void> {
  await query(`DELETE FROM user_record_layouts WHERE user_id = $1`, [userId]);
}
