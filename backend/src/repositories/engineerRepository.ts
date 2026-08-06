import type pg from "pg";
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
  /**
   * The engineer's own region, carried so the caller can narrow the picker to
   * whichever ASP code the user is working in. `engineers.region_id` is NOT
   * NULL and FKs to regions, so the join always resolves — but both stay
   * nullable in the type because an older API build omits them entirely, and
   * the frontend must degrade to "show everyone" rather than to an empty list.
   */
  regionCode: string | null;
  regionName: string | null;
}

export async function listEngineersForDropdown(
  regionId: string | null,
): Promise<DropdownEngineer[]> {
  const conditions: string[] = ["e.is_active = TRUE"];
  const params: unknown[] = [];

  if (regionId) {
    params.push(regionId);
    conditions.push(`e.region_id = $${params.length}`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const result = await query<{
    id: string;
    engineer_code: string | null;
    engineer_name: string;
    region_code: string | null;
    region_name: string | null;
  }>(
    `
      SELECT e.id, e.engineer_code, e.engineer_name,
             r.code AS region_code, r.name AS region_name
      FROM engineers e
      JOIN regions r ON r.id = e.region_id
      ${where}
      ORDER BY e.engineer_name ASC
    `,
    params,
  );

  return result.rows.map((row) => ({
    id: row.id,
    engineerCode: row.engineer_code,
    engineerName: row.engineer_name,
    regionCode: row.region_code,
    regionName: row.region_name,
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

/**
 * Finds an engineer in a region whose name matches case-insensitively
 * (trimmed). Used to detect rename collisions: two distinct engineer records
 * in the same region must never share a name, because historical call/report
 * rows reference engineers by NAME string only.
 */
export async function findEngineerByNameInRegion(
  engineerName: string,
  regionId: string,
  excludeId?: string,
): Promise<Engineer | null> {
  const params: unknown[] = [engineerName, regionId];
  let excludeClause = "";
  if (excludeId) {
    params.push(excludeId);
    excludeClause = `AND id <> $${params.length}`;
  }

  const result = await query<EngineerRow>(
    `
      SELECT ${ENGINEER_COLUMNS}
      FROM engineers
      WHERE lower(trim(engineer_name)) = lower(trim($1))
        AND region_id = $2
        ${excludeClause}
      LIMIT 1
    `,
    params,
  );
  const row = result.rows[0];
  return row ? mapEngineer(row) : null;
}

export async function updateEngineer(
  id: string,
  input: UpdateEngineerInput,
  client?: pg.PoolClient,
): Promise<Engineer | null> {
  const run = client
    ? <T extends pg.QueryResultRow>(text: string, params: unknown[]) =>
        client.query<T>(text, params)
    : <T extends pg.QueryResultRow>(text: string, params: unknown[]) =>
        query<T>(text, params);
  const result = await run<EngineerRow>(
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

/** Region scope for a historical engineer-name remap. */
export interface EngineerRenameScope {
  /** The engineer's region id (matches report/batch region_id columns). */
  regionId: string;
  /**
   * Every ASP work-location code the region covers (upper-cased), from
   * aspCodesForRegion(...). Report rows carry ASP codes in work_location; this
   * is the canonical per-row region signal (reports.region_id can be NULL on
   * combined reports).
   */
  aspCodes: readonly string[];
}

export interface RenameEngineerHistoryCounts {
  /** daily_call_plan_report_rows.engineer values rewritten. */
  reportRows: number;
  /** call_plan_records.engineer values rewritten. */
  callPlanRecords: number;
}

/**
 * Renaming an engineer cascades to the historical call/report rows that store
 * the engineer as a NAME string, so filters and reports never show the same
 * person twice ("JEEVA" vs "JEEVA CH"). Matching is case-insensitive and
 * trimmed, so casing/whitespace variants of the old name are normalised onto
 * the new spelling too — and rows that already carry the NEW name in a
 * different casing are normalised as well, so the rename can never split one
 * engineer into two casing buckets.
 *
 * Region-scoped: only rows attributable to the engineer's region are touched,
 * so a same-named engineer in another region is never clobbered.
 *   - report rows match when their work_location ASP code belongs to the
 *     region OR their parent report is region-scoped to it;
 *   - call plan records match when their upload batch is region-scoped to it
 *     (records in region-less batches are left alone — their region is
 *     unknowable).
 *
 * Runs on the caller's transaction client so the engineers-row rename and the
 * historical remap commit or roll back together. The audit trail
 * (user_activity_log) and frozen EOD productivity snapshots are deliberately
 * left untouched.
 */
export async function renameEngineerInHistoricalRows(
  client: pg.PoolClient,
  oldName: string,
  newName: string,
  scope: EngineerRenameScope,
): Promise<RenameEngineerHistoryCounts> {
  const aspCodes = scope.aspCodes.map((code) => code.trim().toUpperCase());

  const reportRowsResult = await client.query(
    `
      UPDATE daily_call_plan_report_rows rows
      SET engineer = $2
      FROM daily_call_plan_reports reports
      WHERE reports.id = rows.report_id
        AND lower(trim(rows.engineer)) IN (lower(trim($1)), lower(trim($2)))
        AND rows.engineer IS DISTINCT FROM $2
        AND (
          upper(trim(coalesce(rows.work_location, ''))) = ANY($3::text[])
          OR reports.region_id = $4::uuid
        )
    `,
    [oldName, newName, aspCodes, scope.regionId],
  );

  const callPlanRecordsResult = await client.query(
    `
      UPDATE call_plan_records records
      SET engineer = $2
      FROM source_upload_batches batches
      WHERE batches.id = records.upload_batch_id
        AND lower(trim(records.engineer)) IN (lower(trim($1)), lower(trim($2)))
        AND records.engineer IS DISTINCT FROM $2
        AND batches.region_id = $3::uuid
    `,
    [oldName, newName, scope.regionId],
  );

  return {
    reportRows: reportRowsResult.rowCount ?? 0,
    callPlanRecords: callPlanRecordsResult.rowCount ?? 0,
  };
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

/**
 * Hard delete. Safe schema-wise: no other table has a foreign key to
 * engineers — historical call/report rows reference engineers by NAME string
 * only, so they are unaffected by deleting the record.
 */
export async function deleteEngineer(id: string): Promise<boolean> {
  const result = await query(`DELETE FROM engineers WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}
