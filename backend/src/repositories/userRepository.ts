import type { PoolClient } from "pg";
import { query } from "../config/database.js";
import type { AuthenticatedUser } from "../types/auth.js";
import type { UserRole } from "@opencall/shared";

interface UserRow {
  id: string;
  email: string;
  username: string | null;
  role: AuthenticatedUser["role"];
  region_id: string | null;
  must_change_password: boolean;
}

interface UserWithPasswordRow extends UserRow {
  password_hash: string;
}

export interface ManagedUserRow {
  id: string;
  email: string;
  username: string | null;
  role: UserRole;
  region_id: string | null;
  is_active: boolean;
  must_change_password: boolean;
  last_login_at: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
  deactivated_at: string | null;
  deactivated_by: string | null;
}

export interface ManagedUser {
  id: string;
  email: string;
  username: string | null;
  role: UserRole;
  regionId: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
  deactivatedAt: string | null;
  deactivatedBy: string | null;
}

export interface AuthenticatedUserWithPassword {
  user: AuthenticatedUser;
  passwordHash: string;
}

export interface ListUsersFilters {
  role?: UserRole;
  regionId?: string | null;
  isActive?: boolean;
  search?: string;
}

const MANAGED_USER_COLUMNS = `
  id,
  email,
  username,
  role,
  region_id,
  is_active,
  must_change_password,
  last_login_at::TEXT AS last_login_at,
  created_at::TEXT AS created_at,
  created_by,
  updated_at::TEXT AS updated_at,
  updated_by,
  deactivated_at::TEXT AS deactivated_at,
  deactivated_by
`;

function mapUser(row: UserRow): AuthenticatedUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    role: row.role,
    regionId: row.region_id,
    region_id: row.region_id,
    mustChangePassword: Boolean(row.must_change_password),
  };
}

function mapManagedUser(row: ManagedUserRow): ManagedUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    role: row.role,
    regionId: row.region_id,
    isActive: Boolean(row.is_active),
    mustChangePassword: Boolean(row.must_change_password),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    deactivatedAt: row.deactivated_at,
    deactivatedBy: row.deactivated_by,
  };
}

export async function findActiveUserById(
  userId: string,
): Promise<AuthenticatedUser | null> {
  const result = await query<UserRow>(
    `
      SELECT id, email, username, role, region_id, must_change_password
      FROM users
      WHERE id = $1
        AND is_active = TRUE
      LIMIT 1
    `,
    [userId],
  );
  const row = result.rows[0];

  return row ? mapUser(row) : null;
}

export async function findActiveUserByEmail(
  email: string,
): Promise<AuthenticatedUser | null> {
  const result = await query<UserRow>(
    `
      SELECT id, email, username, role, region_id, must_change_password
      FROM users
      WHERE lower(email) = lower($1)
        AND is_active = TRUE
      LIMIT 1
    `,
    [email],
  );
  const row = result.rows[0];

  return row ? mapUser(row) : null;
}

export async function findActiveUserWithPasswordByLogin(
  login: string,
): Promise<AuthenticatedUserWithPassword | null> {
  const result = await query<UserWithPasswordRow>(
    `
      SELECT id, email, username, password_hash, role, region_id, must_change_password
      FROM users
      WHERE (
          lower(email) = lower($1)
          OR lower(username) = lower($1)
        )
        AND is_active = TRUE
      LIMIT 1
    `,
    [login],
  );
  const row = result.rows[0];

  return row
    ? {
        user: mapUser(row),
        passwordHash: row.password_hash,
      }
    : null;
}

export async function findActiveUserByIdForShare(
  client: PoolClient,
  userId: string,
): Promise<AuthenticatedUser | null> {
  const result = await client.query<UserRow>(
    `
      SELECT id, email, username, role, region_id, must_change_password
      FROM users
      WHERE id = $1
        AND is_active = TRUE
      LIMIT 1
      FOR SHARE
    `,
    [userId],
  );
  const row = result.rows[0];

  return row ? mapUser(row) : null;
}

export async function findPasswordHashById(
  userId: string,
): Promise<string | null> {
  const result = await query<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  return result.rows[0]?.password_hash ?? null;
}

export async function touchLastLogin(userId: string): Promise<void> {
  await query(
    `UPDATE users SET last_login_at = NOW() WHERE id = $1`,
    [userId],
  );
}

export async function listManagedUsers(
  filters: ListUsersFilters,
): Promise<ManagedUser[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.role) {
    params.push(filters.role);
    conditions.push(`role = $${params.length}`);
  }
  if (filters.regionId === null) {
    conditions.push(`region_id IS NULL`);
  } else if (filters.regionId) {
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
      `(lower(email) LIKE $${params.length} OR lower(coalesce(username,'')) LIKE $${params.length})`,
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await query<ManagedUserRow>(
    `
      SELECT ${MANAGED_USER_COLUMNS}
      FROM users
      ${where}
      ORDER BY created_at DESC, id ASC
    `,
    params,
  );
  return result.rows.map(mapManagedUser);
}

export async function findManagedUserById(
  userId: string,
): Promise<ManagedUser | null> {
  const result = await query<ManagedUserRow>(
    `
      SELECT ${MANAGED_USER_COLUMNS}
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [userId],
  );
  const row = result.rows[0];
  return row ? mapManagedUser(row) : null;
}

export interface InsertManagedUserInput {
  email: string;
  username: string | null;
  passwordHash: string;
  role: UserRole;
  regionId: string | null;
  mustChangePassword: boolean;
  createdBy: string;
}

export async function insertManagedUser(
  input: InsertManagedUserInput,
): Promise<ManagedUser> {
  const result = await query<ManagedUserRow>(
    `
      INSERT INTO users (
        email, username, password_hash, role, region_id,
        is_active, must_change_password, created_by, updated_by
      )
      VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $7)
      RETURNING ${MANAGED_USER_COLUMNS}
    `,
    [
      input.email,
      input.username,
      input.passwordHash,
      input.role,
      input.regionId,
      input.mustChangePassword,
      input.createdBy,
    ],
  );
  return mapManagedUser(result.rows[0]!);
}

export interface UpdateManagedUserProfileInput {
  email?: string;
  username?: string | null;
  updatedBy: string;
}

export async function updateManagedUserProfile(
  userId: string,
  input: UpdateManagedUserProfileInput,
): Promise<ManagedUser | null> {
  const result = await query<ManagedUserRow>(
    `
      UPDATE users
      SET
        email     = COALESCE($2, email),
        username  = CASE WHEN $4::BOOLEAN THEN $3 ELSE username END,
        updated_at = NOW(),
        updated_by = $5
      WHERE id = $1
      RETURNING ${MANAGED_USER_COLUMNS}
    `,
    [
      userId,
      input.email ?? null,
      input.username ?? null,
      input.username !== undefined,
      input.updatedBy,
    ],
  );
  const row = result.rows[0];
  return row ? mapManagedUser(row) : null;
}

export interface UpdateManagedUserRoleInput {
  role: UserRole;
  regionId: string | null;
  updatedBy: string;
}

export async function updateManagedUserRole(
  userId: string,
  input: UpdateManagedUserRoleInput,
): Promise<ManagedUser | null> {
  const result = await query<ManagedUserRow>(
    `
      UPDATE users
      SET
        role       = $2,
        region_id  = $3,
        updated_at = NOW(),
        updated_by = $4
      WHERE id = $1
      RETURNING ${MANAGED_USER_COLUMNS}
    `,
    [userId, input.role, input.regionId, input.updatedBy],
  );
  const row = result.rows[0];
  return row ? mapManagedUser(row) : null;
}

export async function updateManagedUserRegion(
  userId: string,
  regionId: string | null,
  updatedBy: string,
): Promise<ManagedUser | null> {
  const result = await query<ManagedUserRow>(
    `
      UPDATE users
      SET
        region_id  = $2,
        updated_at = NOW(),
        updated_by = $3
      WHERE id = $1
      RETURNING ${MANAGED_USER_COLUMNS}
    `,
    [userId, regionId, updatedBy],
  );
  const row = result.rows[0];
  return row ? mapManagedUser(row) : null;
}

export async function updateManagedUserPassword(
  userId: string,
  passwordHash: string,
  mustChangePassword: boolean,
  updatedBy: string,
): Promise<ManagedUser | null> {
  const result = await query<ManagedUserRow>(
    `
      UPDATE users
      SET
        password_hash         = $2,
        must_change_password  = $3,
        updated_at            = NOW(),
        updated_by            = $4
      WHERE id = $1
      RETURNING ${MANAGED_USER_COLUMNS}
    `,
    [userId, passwordHash, mustChangePassword, updatedBy],
  );
  const row = result.rows[0];
  return row ? mapManagedUser(row) : null;
}

export async function setManagedUserActive(
  userId: string,
  isActive: boolean,
  actorId: string,
): Promise<ManagedUser | null> {
  const result = await query<ManagedUserRow>(
    `
      UPDATE users
      SET
        is_active        = $2,
        deactivated_at   = CASE WHEN $2 = FALSE THEN NOW() ELSE NULL END,
        deactivated_by   = CASE WHEN $2 = FALSE THEN $3 ELSE NULL END,
        updated_at       = NOW(),
        updated_by       = $3
      WHERE id = $1
      RETURNING ${MANAGED_USER_COLUMNS}
    `,
    [userId, isActive, actorId],
  );
  const row = result.rows[0];
  return row ? mapManagedUser(row) : null;
}

export async function countActiveSuperAdmins(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM users WHERE role = 'SUPER_ADMIN' AND is_active = TRUE`,
  );
  return Number(result.rows[0]?.count ?? "0");
}
