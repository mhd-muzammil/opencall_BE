import { query } from "../config/database.js";

export interface EngineerRow {
  id: string;
  engineer_code: string | null;
  engineer_name: string;
  region_id: string;
  email: string | null;
  phone: string | null;
  hp_id: string;
  vendor_id: string;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Engineer {
  id: string;
  engineerCode: string | null;
  engineerName: string;
  regionId: string;
  email: string | null;
  phone: string | null;
  hpId: string;
  vendorId: string;
  isActive: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const ENGINEER_COLUMNS = `
  id,
  engineer_code,
  engineer_name,
  region_id,
  email,
  phone,
  hp_id,
  vendor_id,
  is_active,
  created_by,
  updated_by,
  created_at::TEXT AS created_at,
  updated_at::TEXT AS updated_at
`;

function mapEngineer(row: EngineerRow): Engineer {
  return {
    id: row.id,
    engineerCode: row.engineer_code,
    engineerName: row.engineer_name,
    regionId: row.region_id,
    email: row.email,
    phone: row.phone,
    hpId: row.hp_id ?? "",
    vendorId: row.vendor_id ?? "",
    isActive: Boolean(row.is_active),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ListEngineersFilters {
  regionId?: string | null;
  isActive?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ListEngineersResult {
  rows: Engineer[];
  total: number;
}

export async function listEngineers(
  filters: ListEngineersFilters,
): Promise<ListEngineersResult> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.regionId) {
    params.push(filters.regionId);
    conditions.push(`region_id = $${params.length}`);
  }
  
  if (typeof filters.isActive === "boolean") {
    params.push(filters.isActive);
    conditions.push(`is_active = $${params.length}`);
  }

  if (filters.search && filters.search.trim().length > 0) {
    params.push(`%${filters.search.trim().toLowerCase()}%`);
    conditions.push(
      `(lower(engineer_name) LIKE $${params.length} OR lower(coalesce(engineer_code,'')) LIKE $${params.length})`,
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  const totalResult = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM engineers ${where}`,
    params,
  );

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const result = await query<EngineerRow>(
    `
      SELECT ${ENGINEER_COLUMNS}
      FROM engineers
      ${where}
      ORDER BY is_active DESC, engineer_name ASC, created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `,
    params,
  );

  return {
    rows: result.rows.map(mapEngineer),
    total: Number(totalResult.rows[0]?.count ?? "0"),
  };
}

export interface DropdownEngineer {
  id: string;
  engineerCode: string | null;
  engineerName: string;
}

export async function listEngineersForDropdown(
  regionId: string | null,
): Promise<DropdownEngineer[]> {
  const conditions: string[] = ["is_active = TRUE"];
  const params: unknown[] = [];

  if (regionId) {
    params.push(regionId);
    conditions.push(`region_id = $${params.length}`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const result = await query<{ id: string; engineer_code: string | null; engineer_name: string }>(
    `
      SELECT id, engineer_code, engineer_name
      FROM engineers
      ${where}
      ORDER BY engineer_name ASC
    `,
    params,
  );

  return result.rows.map((row) => ({
    id: row.id,
    engineerCode: row.engineer_code,
    engineerName: row.engineer_name,
  }));
}

export async function findEngineerById(id: string): Promise<Engineer | null> {
  const result = await query<EngineerRow>(
    `
      SELECT ${ENGINEER_COLUMNS}
      FROM engineers
      WHERE id = $1
      LIMIT 1
    `,
    [id],
  );
  const row = result.rows[0];
  return row ? mapEngineer(row) : null;
}

export interface InsertEngineerInput {
  engineerCode: string | null;
  engineerName: string;
  regionId: string;
  email: string | null;
  phone: string | null;
  hpId?: string;
  vendorId?: string;
  createdBy: string;
}

export async function insertEngineer(
  input: InsertEngineerInput,
): Promise<Engineer> {
  const result = await query<EngineerRow>(
    `
      INSERT INTO engineers (
        engineer_code, engineer_name, region_id, email, phone,
        hp_id, vendor_id, is_active, created_by, updated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $8)
      RETURNING ${ENGINEER_COLUMNS}
    `,
    [
      input.engineerCode,
      input.engineerName,
      input.regionId,
      input.email,
      input.phone,
      input.hpId ?? "",
      input.vendorId ?? "",
      input.createdBy,
    ],
  );
  return mapEngineer(result.rows[0]!);
}

export interface UpdateEngineerInput {
  engineerCode?: string | null;
  engineerName?: string;
  regionId?: string;
  email?: string | null;
  phone?: string | null;
  hpId?: string;
  vendorId?: string;
  updatedBy: string;
}

export async function updateEngineer(
  id: string,
  input: UpdateEngineerInput,
): Promise<Engineer | null> {
  const result = await query<EngineerRow>(
    `
      UPDATE engineers
      SET
        engineer_code = CASE WHEN $2::BOOLEAN THEN $3 ELSE engineer_code END,
        engineer_name = COALESCE($4, engineer_name),
        region_id = COALESCE($5, region_id),
        email = CASE WHEN $6::BOOLEAN THEN $7 ELSE email END,
        phone = CASE WHEN $8::BOOLEAN THEN $9 ELSE phone END,
        hp_id = CASE WHEN $11::BOOLEAN THEN $12 ELSE hp_id END,
        vendor_id = CASE WHEN $13::BOOLEAN THEN $14 ELSE vendor_id END,
        updated_at = NOW(),
        updated_by = $10
      WHERE id = $1
      RETURNING ${ENGINEER_COLUMNS}
    `,
    [
      id,
      input.engineerCode !== undefined,
      input.engineerCode ?? null,
      input.engineerName ?? null,
      input.regionId ?? null,
      input.email !== undefined,
      input.email ?? null,
      input.phone !== undefined,
      input.phone ?? null,
      input.updatedBy,
      input.hpId !== undefined,
      input.hpId ?? "",
      input.vendorId !== undefined,
      input.vendorId ?? "",
    ],
  );
  const row = result.rows[0];
  return row ? mapEngineer(row) : null;
}

export async function setEngineerActive(
  id: string,
  isActive: boolean,
  updatedBy: string,
): Promise<Engineer | null> {
  const result = await query<EngineerRow>(
    `
      UPDATE engineers
      SET
        is_active = $2,
        updated_at = NOW(),
        updated_by = $3
      WHERE id = $1
      RETURNING ${ENGINEER_COLUMNS}
    `,
    [id, isActive, updatedBy],
  );
  const row = result.rows[0];
  return row ? mapEngineer(row) : null;
}
