import bcrypt from "bcryptjs";
import type { UserRole } from "@opencall/shared";
import {
  countActiveSuperAdmins,
  findManagedUserById,
  findPasswordHashById,
  insertManagedUser,
  listManagedUsers,
  setManagedUserActive,
  updateManagedUserPassword,
  updateManagedUserProfile,
  updateManagedUserRegion,
  updateManagedUserRole,
  type ListUsersFilters,
  type ManagedUser,
} from "../../repositories/userRepository.js";
import { findRegionById } from "../../repositories/regionRepository.js";
import {
  badRequest,
  conflict,
  forbidden,
  unauthorized,
  unprocessableEntity,
} from "../../utils/httpError.js";

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;

async function ensureRegionExists(regionId: string): Promise<void> {
  const region = await findRegionById(regionId);
  if (!region) {
    throw unprocessableEntity("Region does not exist", { regionId });
  }
}

function ensureValidRoleRegionPair(role: UserRole, regionId: string | null): void {
  if (role === "REGION_ADMIN" && !regionId) {
    throw unprocessableEntity("REGION_ADMIN users must be assigned to a region");
  }
  if (role === "SUPER_ADMIN" && regionId) {
    throw unprocessableEntity("SUPER_ADMIN users cannot have a region");
  }
}

function ensurePasswordStrength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw unprocessableEntity(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
}

async function loadUserOr404(userId: string): Promise<ManagedUser> {
  const user = await findManagedUserById(userId);
  if (!user) {
    throw unprocessableEntity("User does not exist", { userId });
  }
  return user;
}

async function ensureNotLastActiveSuperAdmin(
  user: ManagedUser,
  reason: string,
): Promise<void> {
  if (user.role !== "SUPER_ADMIN" || !user.isActive) {
    return;
  }
  const activeCount = await countActiveSuperAdmins();
  if (activeCount <= 1) {
    throw conflict(reason, { activeSuperAdminCount: activeCount });
  }
}

export async function listUsers(filters: ListUsersFilters): Promise<ManagedUser[]> {
  return listManagedUsers(filters);
}

export async function getUser(userId: string): Promise<ManagedUser> {
  return loadUserOr404(userId);
}

export interface CreateUserInput {
  email: string;
  username: string | null;
  password: string;
  role: UserRole;
  regionId: string | null;
  mustChangePassword?: boolean;
  actorId: string;
}

export async function createUser(input: CreateUserInput): Promise<ManagedUser> {
  ensurePasswordStrength(input.password);
  ensureValidRoleRegionPair(input.role, input.regionId);
  if (input.regionId) {
    await ensureRegionExists(input.regionId);
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  try {
    return await insertManagedUser({
      email: input.email,
      username: input.username,
      passwordHash,
      role: input.role,
      regionId: input.regionId,
      mustChangePassword: input.mustChangePassword ?? true,
      createdBy: input.actorId,
    });
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      throw conflict("Email or username already exists");
    }
    throw error;
  }
}

export interface UpdateProfileInput {
  email?: string;
  username?: string | null;
  actorId: string;
}

export async function updateUserProfile(
  userId: string,
  input: UpdateProfileInput,
): Promise<ManagedUser> {
  await loadUserOr404(userId);
  try {
    const updated = await updateManagedUserProfile(userId, {
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.username !== undefined ? { username: input.username } : {}),
      updatedBy: input.actorId,
    });
    if (!updated) {
      throw unprocessableEntity("User could not be updated", { userId });
    }
    return updated;
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      throw conflict("Email or username already exists");
    }
    throw error;
  }
}

export interface ChangeRoleInput {
  role: UserRole;
  regionId: string | null;
  actorId: string;
}

export async function changeUserRole(
  userId: string,
  input: ChangeRoleInput,
): Promise<ManagedUser> {
  const target = await loadUserOr404(userId);
  ensureValidRoleRegionPair(input.role, input.regionId);
  if (input.regionId) {
    await ensureRegionExists(input.regionId);
  }
  if (target.role === "SUPER_ADMIN" && input.role !== "SUPER_ADMIN") {
    await ensureNotLastActiveSuperAdmin(
      target,
      "Cannot demote the last active SUPER_ADMIN",
    );
  }
  const updated = await updateManagedUserRole(userId, {
    role: input.role,
    regionId: input.regionId,
    updatedBy: input.actorId,
  });
  if (!updated) {
    throw unprocessableEntity("User role could not be updated", { userId });
  }
  return updated;
}

export async function reassignUserRegion(
  userId: string,
  regionId: string | null,
  actorId: string,
): Promise<ManagedUser> {
  const target = await loadUserOr404(userId);
  ensureValidRoleRegionPair(target.role, regionId);
  if (regionId) {
    await ensureRegionExists(regionId);
  }
  const updated = await updateManagedUserRegion(userId, regionId, actorId);
  if (!updated) {
    throw unprocessableEntity("User region could not be updated", { userId });
  }
  return updated;
}

export interface AdminResetPasswordInput {
  password: string;
  requireChange: boolean;
  actorId: string;
}

export async function adminResetPassword(
  userId: string,
  input: AdminResetPasswordInput,
): Promise<ManagedUser> {
  await loadUserOr404(userId);
  ensurePasswordStrength(input.password);
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const updated = await updateManagedUserPassword(
    userId,
    passwordHash,
    input.requireChange,
    input.actorId,
  );
  if (!updated) {
    throw unprocessableEntity("Password could not be updated", { userId });
  }
  return updated;
}

export async function deactivateUser(
  userId: string,
  actorId: string,
): Promise<ManagedUser> {
  if (userId === actorId) {
    throw forbidden("Cannot deactivate yourself");
  }
  const target = await loadUserOr404(userId);
  if (!target.isActive) {
    return target;
  }
  await ensureNotLastActiveSuperAdmin(
    target,
    "Cannot deactivate the last active SUPER_ADMIN",
  );
  const updated = await setManagedUserActive(userId, false, actorId);
  if (!updated) {
    throw unprocessableEntity("User could not be deactivated", { userId });
  }
  return updated;
}

export async function reactivateUser(
  userId: string,
  actorId: string,
): Promise<ManagedUser> {
  const target = await loadUserOr404(userId);
  if (target.isActive) {
    return target;
  }
  const updated = await setManagedUserActive(userId, true, actorId);
  if (!updated) {
    throw unprocessableEntity("User could not be reactivated", { userId });
  }
  return updated;
}

export interface SelfPasswordChangeInput {
  userId: string;
  currentPassword: string;
  newPassword: string;
}

export async function changeOwnPassword(
  input: SelfPasswordChangeInput,
): Promise<void> {
  ensurePasswordStrength(input.newPassword);
  const currentHash = await findPasswordHashById(input.userId);
  if (!currentHash) {
    throw unauthorized("User not found");
  }
  const matches = await bcrypt.compare(input.currentPassword, currentHash);
  if (!matches) {
    throw badRequest("Current password is incorrect");
  }
  const newHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);
  await updateManagedUserPassword(input.userId, newHash, false, input.userId);
}
