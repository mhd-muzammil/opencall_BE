import bcrypt from "bcryptjs";
import type {
  SpecialAccessDataScope,
  SpecialAccessPermissionLevel,
} from "@opencall/shared";
import {
  listAccessRoles,
  findAccessRoleById,
  insertAccessRole,
  updateAccessRole,
  deleteAccessRole,
  countSpecialAccessUsingRole,
  listSpecialAccess,
  findSpecialAccessById,
  insertSpecialAccess,
  updateSpecialAccess,
  deleteSpecialAccess,
  type AccessRole,
  type SpecialAccessRecord,
} from "../../repositories/specialAccessRepository.js";
import { findRegionById } from "../../repositories/regionRepository.js";
import { conflict, unprocessableEntity } from "../../utils/httpError.js";

const BCRYPT_ROUNDS = 12;

async function ensureRoleExists(roleId: string): Promise<void> {
  const role = await findAccessRoleById(roleId);
  if (!role) {
    throw unprocessableEntity("Access role does not exist", { roleId });
  }
}

async function ensureRegionsExist(regionIds: readonly string[]): Promise<void> {
  for (const regionId of regionIds) {
    const region = await findRegionById(regionId);
    if (!region) {
      throw unprocessableEntity("Region does not exist", { regionId });
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

// --------------------------- access roles ---------------------------

export function getAccessRoles(includeInactive: boolean): Promise<AccessRole[]> {
  return listAccessRoles(includeInactive);
}

export async function getAccessRole(roleId: string): Promise<AccessRole> {
  const role = await findAccessRoleById(roleId);
  if (!role) {
    throw unprocessableEntity("Access role does not exist", { roleId });
  }
  return role;
}

export interface CreateAccessRoleInput {
  name: string;
  description: string | null;
  defaultSections: string[];
  defaultDataScope: SpecialAccessDataScope;
  defaultPermissionLevel: SpecialAccessPermissionLevel;
  actorId: string;
}

export async function createAccessRole(
  input: CreateAccessRoleInput,
): Promise<AccessRole> {
  try {
    return await insertAccessRole({
      name: input.name,
      description: input.description,
      defaultSections: input.defaultSections,
      defaultDataScope: input.defaultDataScope,
      defaultPermissionLevel: input.defaultPermissionLevel,
      createdBy: input.actorId,
    });
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      throw conflict("An access role with this name already exists");
    }
    throw error;
  }
}

export interface UpdateAccessRoleServiceInput {
  name?: string | undefined;
  description?: string | null | undefined;
  defaultSections?: string[] | undefined;
  defaultDataScope?: SpecialAccessDataScope | undefined;
  defaultPermissionLevel?: SpecialAccessPermissionLevel | undefined;
  isActive?: boolean | undefined;
  actorId: string;
}

export async function editAccessRole(
  roleId: string,
  input: UpdateAccessRoleServiceInput,
): Promise<AccessRole> {
  await getAccessRole(roleId);
  try {
    const updated = await updateAccessRole(roleId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.defaultSections !== undefined
        ? { defaultSections: input.defaultSections }
        : {}),
      ...(input.defaultDataScope !== undefined
        ? { defaultDataScope: input.defaultDataScope }
        : {}),
      ...(input.defaultPermissionLevel !== undefined
        ? { defaultPermissionLevel: input.defaultPermissionLevel }
        : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      updatedBy: input.actorId,
    });
    if (!updated) {
      throw unprocessableEntity("Access role could not be updated", { roleId });
    }
    return updated;
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      throw conflict("An access role with this name already exists");
    }
    throw error;
  }
}

export async function removeAccessRole(roleId: string): Promise<void> {
  await getAccessRole(roleId);
  const inUse = await countSpecialAccessUsingRole(roleId);
  if (inUse > 0) {
    throw conflict(
      "Cannot delete a role that is still assigned to special-access logins",
      { assignedCount: inUse },
    );
  }
  await deleteAccessRole(roleId);
}

// --------------------------- special access ---------------------------

export function getSpecialAccessList(): Promise<SpecialAccessRecord[]> {
  return listSpecialAccess();
}

export async function getSpecialAccess(id: string): Promise<SpecialAccessRecord> {
  const record = await findSpecialAccessById(id);
  if (!record) {
    throw unprocessableEntity("Special-access login does not exist", { id });
  }
  return record;
}

export interface CreateSpecialAccessInput {
  username: string;
  password: string;
  roleId: string | null;
  sections: string[];
  allRegions: boolean;
  regions: string[];
  dataScope: SpecialAccessDataScope;
  permissionLevel: SpecialAccessPermissionLevel;
  actorId: string;
}

export async function createSpecialAccessLogin(
  input: CreateSpecialAccessInput,
): Promise<SpecialAccessRecord> {
  if (input.roleId) {
    await ensureRoleExists(input.roleId);
  }
  if (!input.allRegions) {
    await ensureRegionsExist(input.regions);
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  try {
    return await insertSpecialAccess({
      username: input.username,
      passwordHash,
      roleId: input.roleId,
      sections: input.sections,
      allRegions: input.allRegions,
      regions: input.allRegions ? [] : input.regions,
      dataScope: input.dataScope,
      permissionLevel: input.permissionLevel,
      createdBy: input.actorId,
    });
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      throw conflict("A special-access login with this username already exists");
    }
    throw error;
  }
}

export interface UpdateSpecialAccessServiceInput {
  roleId?: string | null | undefined;
  sections?: string[] | undefined;
  allRegions?: boolean | undefined;
  regions?: string[] | undefined;
  dataScope?: SpecialAccessDataScope | undefined;
  permissionLevel?: SpecialAccessPermissionLevel | undefined;
  isActive?: boolean | undefined;
  actorId: string;
}

export async function editSpecialAccessLogin(
  id: string,
  input: UpdateSpecialAccessServiceInput,
): Promise<SpecialAccessRecord> {
  const existing = await getSpecialAccess(id);

  if (input.roleId) {
    await ensureRoleExists(input.roleId);
  }

  const effectiveAllRegions = input.allRegions ?? existing.allRegions;
  const effectiveRegions = input.regions ?? existing.regions;
  if (!effectiveAllRegions) {
    await ensureRegionsExist(effectiveRegions);
    if (effectiveRegions.length === 0) {
      throw unprocessableEntity(
        "Select at least one region, or grant all regions",
      );
    }
  }

  const updated = await updateSpecialAccess(id, {
    ...(input.roleId !== undefined ? { roleId: input.roleId } : {}),
    ...(input.sections !== undefined ? { sections: input.sections } : {}),
    ...(input.allRegions !== undefined ? { allRegions: input.allRegions } : {}),
    // when switching to all-regions, clear the explicit list
    ...(effectiveAllRegions ? { regions: [] } : { regions: effectiveRegions }),
    ...(input.dataScope !== undefined ? { dataScope: input.dataScope } : {}),
    ...(input.permissionLevel !== undefined
      ? { permissionLevel: input.permissionLevel }
      : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    updatedBy: input.actorId,
  });
  if (!updated) {
    throw unprocessableEntity("Special-access login could not be updated", { id });
  }
  return updated;
}

export async function resetSpecialAccessPassword(
  id: string,
  password: string,
  actorId: string,
): Promise<SpecialAccessRecord> {
  await getSpecialAccess(id);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const updated = await updateSpecialAccess(id, {
    passwordHash,
    updatedBy: actorId,
  });
  if (!updated) {
    throw unprocessableEntity("Password could not be updated", { id });
  }
  return updated;
}

export async function removeSpecialAccessLogin(id: string): Promise<void> {
  await getSpecialAccess(id);
  await deleteSpecialAccess(id);
}
