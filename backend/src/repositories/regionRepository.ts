import { query } from "../config/database.js";

export interface RegionRow {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
  created_at: string;
}

export interface Region {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  createdAt: string;
}

function mapRegion(row: RegionRow): Region {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
  };
}

export async function listRegions(
  options: { activeOnly?: boolean } = {},
): Promise<Region[]> {
  const conditions: string[] = [];
  if (options.activeOnly) {
    conditions.push("is_active = TRUE");
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await query<RegionRow>(
    `
      SELECT id, code, name, is_active, created_at::TEXT AS created_at
      FROM regions
      ${where}
      ORDER BY name ASC
    `,
  );
  return result.rows.map(mapRegion);
}

export async function findRegionById(id: string): Promise<Region | null> {
  const result = await query<RegionRow>(
    `
      SELECT id, code, name, is_active, created_at::TEXT AS created_at
      FROM regions
      WHERE id = $1
      LIMIT 1
    `,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRegion(row) : null;
}

export async function findRegionByCode(code: string): Promise<Region | null> {
  const result = await query<RegionRow>(
    `
      SELECT id, code, name, is_active, created_at::TEXT AS created_at
      FROM regions
      WHERE upper(code) = upper($1)
      LIMIT 1
    `,
    [code],
  );
  const row = result.rows[0];
  return row ? mapRegion(row) : null;
}
