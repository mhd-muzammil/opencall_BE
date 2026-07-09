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

/**
 * Raw column headers from the most recently uploaded Flex WIP file. These are
 * the actual Excel column names, offered in the Record Format catalog on top of
 * the standard report columns so users can surface any raw field. Empty if no
 * Flex WIP has been uploaded yet.
 */
export async function findLatestFlexRawColumnHeaders(): Promise<string[]> {
  const result = await query<{ raw_row: Record<string, unknown> }>(
    `
      SELECT raw_row
      FROM flex_wip_records
      WHERE raw_row IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `,
  );

  const rawRow = result.rows[0]?.raw_row;
  return rawRow ? Object.keys(rawRow) : [];
}

/**
 * The distinct column keys present in any SUPER_ADMIN's saved layout. Region
 * admins may only use raw Excel columns a super admin has enabled (i.e. included
 * in their own layout), so this is the source of truth for "enabled extras".
 */
export async function findColumnsUsedBySuperAdmins(): Promise<string[]> {
  const result = await query<{ col: string }>(
    `
      SELECT DISTINCT jsonb_array_elements_text(layouts.ordered_columns) AS col
      FROM user_record_layouts layouts
      JOIN users ON users.id = layouts.user_id
      WHERE users.role = 'SUPER_ADMIN'
    `,
  );
  return result.rows.map((r) => r.col);
}
