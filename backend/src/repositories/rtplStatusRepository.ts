import { query, withTransaction } from "../config/database.js";

export interface RtplStatusRow {
  id: string;
  name: string;
  category: string;
  sort_order: number;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RtplStatus {
  id: string;
  name: string;
  category: string;
  sortOrder: number;
  isActive: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const RTPL_STATUS_COLUMNS = `
  id,
  name,
  category,
  sort_order,
  is_active,
  created_by,
  updated_by,
  created_at::TEXT AS created_at,
  updated_at::TEXT AS updated_at
`;

function mapRtplStatus(row: RtplStatusRow): RtplStatus {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    sortOrder: Number(row.sort_order),
    isActive: Boolean(row.is_active),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ListRtplStatusesFilters {
  isActive?: boolean;
  category?: string;
  search?: string;
}

export async function listRtplStatuses(
  filters: ListRtplStatusesFilters,
): Promise<RtplStatus[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (typeof filters.isActive === "boolean") {
    params.push(filters.isActive);
    conditions.push(`is_active = $${params.length}`);
  }

  if (filters.category && filters.category.trim().length > 0) {
    params.push(filters.category.trim());
    conditions.push(`category = $${params.length}`);
  }

  if (filters.search && filters.search.trim().length > 0) {
    params.push(`%${filters.search.trim().toLowerCase()}%`);
    conditions.push(
      `(lower(name) LIKE $${params.length} OR lower(category) LIKE $${params.length})`,
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await query<RtplStatusRow>(
    `
      SELECT ${RTPL_STATUS_COLUMNS}
      FROM rtpl_statuses
      ${where}
      ORDER BY is_active DESC, sort_order ASC, name ASC
    `,
    params,
  );

  return result.rows.map(mapRtplStatus);
}

export interface DropdownRtplStatus {
  id: string;
  name: string;
  category: string;
}

export async function listRtplStatusesForDropdown(): Promise<DropdownRtplStatus[]> {
  const result = await query<{ id: string; name: string; category: string }>(
    `
      SELECT id, name, category
      FROM rtpl_statuses
      WHERE is_active = TRUE
      ORDER BY sort_order ASC, name ASC
    `,
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    category: row.category,
  }));
}

export async function findRtplStatusById(id: string): Promise<RtplStatus | null> {
  const result = await query<RtplStatusRow>(
    `
      SELECT ${RTPL_STATUS_COLUMNS}
      FROM rtpl_statuses
      WHERE id = $1
      LIMIT 1
    `,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRtplStatus(row) : null;
}

export async function findRtplStatusByName(name: string): Promise<RtplStatus | null> {
  const result = await query<RtplStatusRow>(
    `
      SELECT ${RTPL_STATUS_COLUMNS}
      FROM rtpl_statuses
      WHERE lower(name) = lower($1)
      LIMIT 1
    `,
    [name],
  );
  const row = result.rows[0];
  return row ? mapRtplStatus(row) : null;
}

export interface InsertRtplStatusInput {
  name: string;
  category: string;
  // When null, the new status is appended after all existing ones so it does not
  // jump to the top of the dropdown.
  sortOrder: number | null;
  createdBy: string;
}

export async function insertRtplStatus(
  input: InsertRtplStatusInput,
): Promise<RtplStatus> {
  const result = await query<RtplStatusRow>(
    `
      INSERT INTO rtpl_statuses (
        name, category, sort_order, is_active, created_by, updated_by
      )
      VALUES (
        $1,
        $2,
        COALESCE($3, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM rtpl_statuses)),
        TRUE,
        $4,
        $4
      )
      RETURNING ${RTPL_STATUS_COLUMNS}
    `,
    [input.name, input.category, input.sortOrder, input.createdBy],
  );
  return mapRtplStatus(result.rows[0]!);
}

export interface UpdateRtplStatusInput {
  name?: string;
  category?: string;
  sortOrder?: number;
  updatedBy: string;
}

export async function updateRtplStatus(
  id: string,
  input: UpdateRtplStatusInput,
): Promise<RtplStatus | null> {
  const result = await query<RtplStatusRow>(
    `
      UPDATE rtpl_statuses
      SET
        name = COALESCE($2, name),
        category = COALESCE($3, category),
        sort_order = COALESCE($4, sort_order),
        updated_at = NOW(),
        updated_by = $5
      WHERE id = $1
      RETURNING ${RTPL_STATUS_COLUMNS}
    `,
    [
      id,
      input.name ?? null,
      input.category ?? null,
      input.sortOrder ?? null,
      input.updatedBy,
    ],
  );
  const row = result.rows[0];
  return row ? mapRtplStatus(row) : null;
}

/**
 * Renaming a status in the admin console cascades to the report rows that
 * carry the old value, so dashboards never show two cards for the same status
 * ("To be Scheduled" vs "To Be Scheduled"). Matching is case-insensitive, so
 * casing variants of the old name are normalised onto the new spelling too.
 * Returns how many column values were rewritten. The audit trail
 * (user_activity_log) is deliberately left untouched.
 */
export async function renameRtplStatusValueInReportRows(
  oldName: string,
  newName: string,
): Promise<number> {
  // Fixed identifiers, not user input — only the VALUES are parameterised.
  const columns = ["rtpl_status", "evening_rtpl_status", "previous_rtpl_status"];

  return withTransaction(async (client) => {
    let updatedValues = 0;
    for (const column of columns) {
      const result = await client.query(
        `
          UPDATE daily_call_plan_report_rows
          SET ${column} = $2
          WHERE lower(${column}) = lower($1)
            AND ${column} IS DISTINCT FROM $2
        `,
        [oldName, newName],
      );
      updatedValues += result.rowCount ?? 0;
    }
    return updatedValues;
  });
}

export async function setRtplStatusActive(
  id: string,
  isActive: boolean,
  updatedBy: string,
): Promise<RtplStatus | null> {
  const result = await query<RtplStatusRow>(
    `
      UPDATE rtpl_statuses
      SET
        is_active = $2,
        updated_at = NOW(),
        updated_by = $3
      WHERE id = $1
      RETURNING ${RTPL_STATUS_COLUMNS}
    `,
    [id, isActive, updatedBy],
  );
  const row = result.rows[0];
  return row ? mapRtplStatus(row) : null;
}

export async function deleteRtplStatus(id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM rtpl_statuses WHERE id = $1`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}
