import type {
  SpecialAccessDataScope,
  SpecialAccessPermissionLevel,
} from "@opencall/shared";
import { query } from "../config/database.js";

// ---------------------------------------------------------------------------
// Access roles (reusable custom role definitions)
// ---------------------------------------------------------------------------

interface AccessRoleRow {
  id: string;
  name: string;
  description: string | null;
  default_sections: string[];
  default_data_scope: SpecialAccessDataScope;
  default_permission_level: SpecialAccessPermissionLevel;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AccessRole {
  id: string;
  name: string;
  description: string | null;
  defaultSections: string[];
  defaultDataScope: SpecialAccessDataScope;
  defaultPermissionLevel: SpecialAccessPermissionLevel;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const ACCESS_ROLE_COLUMNS = `
  id,
  name,
  description,
  default_sections,
  default_data_scope,
  default_permission_level,
  is_active,
  created_at::TEXT AS created_at,
  updated_at::TEXT AS updated_at
`;

function mapAccessRole(row: AccessRoleRow): AccessRole {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    defaultSections: row.default_sections ?? [],
    defaultDataScope: row.default_data_scope,
    defaultPermissionLevel: row.default_permission_level,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAccessRoles(includeInactive: boolean): Promise<AccessRole[]> {
  const where = includeInactive ? "" : "WHERE is_active = TRUE";
  const result = await query<AccessRoleRow>(
    `SELECT ${ACCESS_ROLE_COLUMNS} FROM access_roles ${where} ORDER BY lower(name) ASC`,
  );
  return result.rows.map(mapAccessRole);
}

export async function findAccessRoleById(id: string): Promise<AccessRole | null> {
  const result = await query<AccessRoleRow>(
    `SELECT ${ACCESS_ROLE_COLUMNS} FROM access_roles WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapAccessRole(row) : null;
}

export interface InsertAccessRoleInput {
  name: string;
  description: string | null;
  defaultSections: string[];
  defaultDataScope: SpecialAccessDataScope;
  defaultPermissionLevel: SpecialAccessPermissionLevel;
  createdBy: string;
}

export async function insertAccessRole(input: InsertAccessRoleInput): Promise<AccessRole> {
  const result = await query<AccessRoleRow>(
    `
      INSERT INTO access_roles (
        name, description, default_sections, default_data_scope,
        default_permission_level, created_by, updated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $6)
      RETURNING ${ACCESS_ROLE_COLUMNS}
    `,
    [
      input.name,
      input.description,
      input.defaultSections,
      input.defaultDataScope,
      input.defaultPermissionLevel,
      input.createdBy,
    ],
  );
  return mapAccessRole(result.rows[0]!);
}

export interface UpdateAccessRoleInput {
  name?: string;
  description?: string | null;
  defaultSections?: string[];
  defaultDataScope?: SpecialAccessDataScope;
  defaultPermissionLevel?: SpecialAccessPermissionLevel;
  isActive?: boolean;
  updatedBy: string;
}

export async function updateAccessRole(
  id: string,
  input: UpdateAccessRoleInput,
): Promise<AccessRole | null> {
  const result = await query<AccessRoleRow>(
    `
      UPDATE access_roles
      SET
        name                     = COALESCE($2, name),
        description              = CASE WHEN $3::BOOLEAN THEN $4 ELSE description END,
        default_sections         = COALESCE($5, default_sections),
        default_data_scope       = COALESCE($6, default_data_scope),
        default_permission_level = COALESCE($7, default_permission_level),
        is_active                = COALESCE($8, is_active),
        updated_at               = NOW(),
        updated_by               = $9
      WHERE id = $1
      RETURNING ${ACCESS_ROLE_COLUMNS}
    `,
    [
      id,
      input.name ?? null,
      input.description !== undefined,
      input.description ?? null,
      input.defaultSections ?? null,
      input.defaultDataScope ?? null,
      input.defaultPermissionLevel ?? null,
      input.isActive ?? null,
      input.updatedBy,
    ],
  );
  const row = result.rows[0];
  return row ? mapAccessRole(row) : null;
}

export async function countSpecialAccessUsingRole(roleId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM special_access WHERE role_id = $1`,
    [roleId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

export async function deleteAccessRole(id: string): Promise<boolean> {
  const result = await query(`DELETE FROM access_roles WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Special access credentials (standalone scoped logins)
// ---------------------------------------------------------------------------

interface SpecialAccessRow {
  id: string;
  username: string;
  role_id: string | null;
  role_name: string | null;
  accessible_sections: string[];
  all_regions: boolean;
  accessible_regions: string[];
  data_scope: SpecialAccessDataScope;
  permission_level: SpecialAccessPermissionLevel;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface SpecialAccessWithPasswordRow extends SpecialAccessRow {
  password_hash: string;
}

export interface SpecialAccessRecord {
  id: string;
  username: string;
  roleId: string | null;
  roleName: string | null;
  sections: string[];
  allRegions: boolean;
  regions: string[];
  dataScope: SpecialAccessDataScope;
  permissionLevel: SpecialAccessPermissionLevel;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const SPECIAL_ACCESS_COLUMNS = `
  sa.id,
  sa.username,
  sa.role_id,
  ar.name AS role_name,
  sa.accessible_sections,
  sa.all_regions,
  sa.accessible_regions,
  sa.data_scope,
  sa.permission_level,
  sa.is_active,
  sa.created_at::TEXT AS created_at,
  sa.updated_at::TEXT AS updated_at
`;

function mapSpecialAccess(row: SpecialAccessRow): SpecialAccessRecord {
  return {
    id: row.id,
    username: row.username,
    roleId: row.role_id,
    roleName: row.role_name,
    sections: row.accessible_sections ?? [],
    allRegions: Boolean(row.all_regions),
    regions: row.accessible_regions ?? [],
    dataScope: row.data_scope,
    permissionLevel: row.permission_level,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listSpecialAccess(): Promise<SpecialAccessRecord[]> {
  const result = await query<SpecialAccessRow>(
    `
      SELECT ${SPECIAL_ACCESS_COLUMNS}
      FROM special_access sa
      LEFT JOIN access_roles ar ON ar.id = sa.role_id
      ORDER BY sa.created_at DESC, sa.id ASC
    `,
  );
  return result.rows.map(mapSpecialAccess);
}

export async function findSpecialAccessById(
  id: string,
): Promise<SpecialAccessRecord | null> {
  const result = await query<SpecialAccessRow>(
    `
      SELECT ${SPECIAL_ACCESS_COLUMNS}
      FROM special_access sa
      LEFT JOIN access_roles ar ON ar.id = sa.role_id
      WHERE sa.id = $1
      LIMIT 1
    `,
    [id],
  );
  const row = result.rows[0];
  return row ? mapSpecialAccess(row) : null;
}

/** Login lookup — includes the password hash and only matches active credentials. */
export async function findActiveSpecialAccessByUsername(
  username: string,
): Promise<{ record: SpecialAccessRecord; passwordHash: string } | null> {
  const result = await query<SpecialAccessWithPasswordRow>(
    `
      SELECT ${SPECIAL_ACCESS_COLUMNS}, sa.password_hash
      FROM special_access sa
      LEFT JOIN access_roles ar ON ar.id = sa.role_id
      WHERE lower(sa.username) = lower($1)
        AND sa.is_active = TRUE
      LIMIT 1
    `,
    [username],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { record: mapSpecialAccess(row), passwordHash: row.password_hash };
}

/** Used by the auth middleware to re-load a principal fresh on every request. */
export async function findActiveSpecialAccessForPrincipal(
  id: string,
): Promise<SpecialAccessRecord | null> {
  const result = await query<SpecialAccessRow>(
    `
      SELECT ${SPECIAL_ACCESS_COLUMNS}
      FROM special_access sa
      LEFT JOIN access_roles ar ON ar.id = sa.role_id
      WHERE sa.id = $1
        AND sa.is_active = TRUE
      LIMIT 1
    `,
    [id],
  );
  const row = result.rows[0];
  return row ? mapSpecialAccess(row) : null;
}

export interface InsertSpecialAccessInput {
  username: string;
  passwordHash: string;
  roleId: string | null;
  sections: string[];
  allRegions: boolean;
  regions: string[];
  dataScope: SpecialAccessDataScope;
  permissionLevel: SpecialAccessPermissionLevel;
  createdBy: string;
}

export async function insertSpecialAccess(
  input: InsertSpecialAccessInput,
): Promise<SpecialAccessRecord> {
  const result = await query<{ id: string }>(
    `
      INSERT INTO special_access (
        username, password_hash, role_id, accessible_sections, all_regions,
        accessible_regions, data_scope, permission_level, created_by, updated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
      RETURNING id
    `,
    [
      input.username,
      input.passwordHash,
      input.roleId,
      input.sections,
      input.allRegions,
      input.regions,
      input.dataScope,
      input.permissionLevel,
      input.createdBy,
    ],
  );
  const created = await findSpecialAccessById(result.rows[0]!.id);
  return created!;
}

export interface UpdateSpecialAccessInput {
  roleId?: string | null;
  sections?: string[];
  allRegions?: boolean;
  regions?: string[];
  dataScope?: SpecialAccessDataScope;
  permissionLevel?: SpecialAccessPermissionLevel;
  isActive?: boolean;
  passwordHash?: string;
  updatedBy: string;
}

export async function updateSpecialAccess(
  id: string,
  input: UpdateSpecialAccessInput,
): Promise<SpecialAccessRecord | null> {
  const result = await query<{ id: string }>(
    `
      UPDATE special_access
      SET
        role_id             = CASE WHEN $2::BOOLEAN THEN $3 ELSE role_id END,
        accessible_sections = COALESCE($4, accessible_sections),
        all_regions         = COALESCE($5, all_regions),
        accessible_regions  = COALESCE($6, accessible_regions),
        data_scope          = COALESCE($7, data_scope),
        permission_level    = COALESCE($8, permission_level),
        is_active           = COALESCE($9, is_active),
        password_hash       = COALESCE($10, password_hash),
        updated_at          = NOW(),
        updated_by          = $11
      WHERE id = $1
      RETURNING id
    `,
    [
      id,
      input.roleId !== undefined,
      input.roleId ?? null,
      input.sections ?? null,
      input.allRegions ?? null,
      input.regions ?? null,
      input.dataScope ?? null,
      input.permissionLevel ?? null,
      input.isActive ?? null,
      input.passwordHash ?? null,
      input.updatedBy,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return findSpecialAccessById(row.id);
}

export async function deleteSpecialAccess(id: string): Promise<boolean> {
  const result = await query(`DELETE FROM special_access WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}
