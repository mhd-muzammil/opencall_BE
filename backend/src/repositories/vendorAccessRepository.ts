import { query } from "../config/database.js";
import type { VendorAccessPermissionLevel } from "@opencall/shared";

/**
 * Vendor Access logins — standalone scoped credentials (rows in `vendor_access`, NOT in
 * `users` and separate from `special_access`). A vendor is scoped to the cases assigned to
 * it (see vendorCaseAssignmentRepository); this repository owns only the login record.
 */

export interface VendorAccessRecord {
  id: string;
  username: string;
  sections: string[];
  permissionLevel: VendorAccessPermissionLevel;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface VendorAccessRow {
  id: string;
  username: string;
  accessible_sections: string[];
  permission_level: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface VendorAccessWithPasswordRow extends VendorAccessRow {
  password_hash: string;
}

const COLUMNS = `
  id, username, accessible_sections, permission_level, is_active,
  created_at, updated_at
`;

function mapVendorAccess(row: VendorAccessRow): VendorAccessRecord {
  return {
    id: row.id,
    username: row.username,
    sections: row.accessible_sections ?? [],
    permissionLevel: row.permission_level as VendorAccessPermissionLevel,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listVendorAccess(): Promise<VendorAccessRecord[]> {
  const result = await query<VendorAccessRow>(
    `SELECT ${COLUMNS} FROM vendor_access ORDER BY lower(username) ASC`,
  );
  return result.rows.map(mapVendorAccess);
}

export async function findVendorAccessById(
  id: string,
): Promise<VendorAccessRecord | null> {
  const result = await query<VendorAccessRow>(
    `SELECT ${COLUMNS} FROM vendor_access WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapVendorAccess(result.rows[0]) : null;
}

/** Login lookup — active credentials only, returns the hash for bcrypt comparison. */
export async function findActiveVendorAccessByUsername(
  username: string,
): Promise<{ record: VendorAccessRecord; passwordHash: string } | null> {
  const result = await query<VendorAccessWithPasswordRow>(
    `SELECT ${COLUMNS}, password_hash FROM vendor_access
      WHERE lower(username) = lower($1) AND is_active = TRUE`,
    [username],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { record: mapVendorAccess(row), passwordHash: row.password_hash };
}

/** Re-load a principal fresh per request in the auth middleware (active only). */
export async function findActiveVendorAccessForPrincipal(
  id: string,
): Promise<VendorAccessRecord | null> {
  const result = await query<VendorAccessRow>(
    `SELECT ${COLUMNS} FROM vendor_access WHERE id = $1 AND is_active = TRUE`,
    [id],
  );
  return result.rows[0] ? mapVendorAccess(result.rows[0]) : null;
}

export interface InsertVendorAccessInput {
  username: string;
  passwordHash: string;
  sections: string[];
  permissionLevel: VendorAccessPermissionLevel;
  createdBy: string;
}

export async function insertVendorAccess(
  input: InsertVendorAccessInput,
): Promise<VendorAccessRecord> {
  const result = await query<VendorAccessRow>(
    `INSERT INTO vendor_access
       (username, password_hash, accessible_sections, permission_level, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING ${COLUMNS}`,
    [
      input.username,
      input.passwordHash,
      input.sections,
      input.permissionLevel,
      input.createdBy,
    ],
  );
  return mapVendorAccess(result.rows[0]!);
}

export interface UpdateVendorAccessInput {
  sections?: string[];
  permissionLevel?: VendorAccessPermissionLevel;
  isActive?: boolean;
  passwordHash?: string;
  updatedBy: string;
}

export async function updateVendorAccess(
  id: string,
  input: UpdateVendorAccessInput,
): Promise<VendorAccessRecord | null> {
  const result = await query<VendorAccessRow>(
    `UPDATE vendor_access SET
       accessible_sections = COALESCE($2, accessible_sections),
       permission_level    = COALESCE($3, permission_level),
       is_active           = COALESCE($4, is_active),
       password_hash       = CASE WHEN $5::TEXT IS NOT NULL THEN $5 ELSE password_hash END,
       updated_by          = $6,
       updated_at          = NOW()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [
      id,
      input.sections ?? null,
      input.permissionLevel ?? null,
      input.isActive ?? null,
      input.passwordHash ?? null,
      input.updatedBy,
    ],
  );
  return result.rows[0] ? mapVendorAccess(result.rows[0]) : null;
}

export async function deleteVendorAccess(id: string): Promise<boolean> {
  const result = await query(`DELETE FROM vendor_access WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}
