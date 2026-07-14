import { query } from "../config/database.js";

/**
 * Records-grid column layout for a SPECIAL ACCESS credential.
 *
 * Mirrors `userRecordLayoutRepository` exactly, but keyed by `special_access.id`
 * instead of `users.id` — special-access logins are not rows in `users`, so they
 * cannot share `user_record_layouts` (its PK is a FK to users.id). Nothing here
 * touches the regular-user table.
 */

export interface SpecialAccessRecordLayout {
  orderedColumns: string[];
  updatedAt: string;
}

interface SpecialAccessRecordLayoutDbRow {
  ordered_columns: string[];
  updated_at: string;
}

/** The credential's saved layout, or null when it has not customised the grid. */
export async function findSpecialAccessRecordLayout(
  specialAccessId: string,
): Promise<SpecialAccessRecordLayout | null> {
  const result = await query<SpecialAccessRecordLayoutDbRow>(
    `
      SELECT ordered_columns, updated_at::TEXT AS updated_at
      FROM special_access_record_layouts
      WHERE special_access_id = $1
    `,
    [specialAccessId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return { orderedColumns: row.ordered_columns, updatedAt: row.updated_at };
}

export async function upsertSpecialAccessRecordLayout(input: {
  specialAccessId: string;
  orderedColumns: readonly string[];
}): Promise<SpecialAccessRecordLayout> {
  const result = await query<SpecialAccessRecordLayoutDbRow>(
    `
      INSERT INTO special_access_record_layouts (special_access_id, ordered_columns, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (special_access_id) DO UPDATE
        SET ordered_columns = EXCLUDED.ordered_columns,
            updated_at = NOW()
      RETURNING ordered_columns, updated_at::TEXT AS updated_at
    `,
    [input.specialAccessId, JSON.stringify(input.orderedColumns)],
  );

  const row = result.rows[0]!;
  return { orderedColumns: row.ordered_columns, updatedAt: row.updated_at };
}

/** Removes the custom layout, reverting the credential to the default full grid. */
export async function deleteSpecialAccessRecordLayout(
  specialAccessId: string,
): Promise<void> {
  await query(
    `DELETE FROM special_access_record_layouts WHERE special_access_id = $1`,
    [specialAccessId],
  );
}
