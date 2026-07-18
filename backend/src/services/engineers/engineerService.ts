import type { AuthenticatedUser } from "../../types/auth.js";
import { forbidden, notFound, badRequest } from "../../utils/httpError.js";
import { insertActivity } from "../../repositories/activityLogRepository.js";
import {
  findEngineerById,
  insertEngineer,
  listEngineers,
  listEngineersForDropdown,
  setEngineerActive,
  updateEngineer,
  type Engineer,
  type ListEngineersFilters,
  type ListEngineersResult,
  type DropdownEngineer,
} from "../../repositories/engineerRepository.js";

function assertRegionAccess(
  currentUser: AuthenticatedUser,
  targetRegionId: string,
): void {
  if (currentUser.role === "REGION_ADMIN" && currentUser.regionId !== targetRegionId) {
    throw forbidden("You do not have permission to manage engineers in this region");
  }
}

export async function getEngineersDropdownService(
  currentUser: AuthenticatedUser,
  requestedRegionId?: string,
): Promise<DropdownEngineer[]> {
  let regionIdToFetch: string | null = null;

  if (currentUser.role === "REGION_ADMIN") {
    if (!currentUser.regionId) {
      throw forbidden("Region admin is not assigned to a region");
    }
    regionIdToFetch = currentUser.regionId;
  } else if (currentUser.role === "SUPER_ADMIN" && requestedRegionId) {
    regionIdToFetch = requestedRegionId;
  }

  return listEngineersForDropdown(regionIdToFetch);
}

export async function listEngineersService(
  currentUser: AuthenticatedUser,
  filters: Omit<ListEngineersFilters, "regionId"> & { regionId?: string },
): Promise<ListEngineersResult> {
  const finalFilters: ListEngineersFilters = { ...filters };

  if (currentUser.role === "REGION_ADMIN") {
    if (!currentUser.regionId) {
      throw forbidden("Region admin is not assigned to a region");
    }
    finalFilters.regionId = currentUser.regionId;
  }

  return listEngineers(finalFilters);
}

export interface CreateEngineerInput {
  engineerCode?: string | null;
  engineerName: string;
  regionId: string;
  email?: string | null;
  phone?: string | null;
  hpId?: string;
  vendorId?: string;
}

export async function createEngineerService(
  currentUser: AuthenticatedUser,
  input: CreateEngineerInput,
): Promise<Engineer> {
  assertRegionAccess(currentUser, input.regionId);

  const engineer = await insertEngineer({
    engineerCode: input.engineerCode ?? null,
    engineerName: input.engineerName.trim(),
    regionId: input.regionId,
    email: input.email ?? null,
    phone: input.phone ?? null,
    hpId: input.hpId?.trim() ?? "",
    vendorId: input.vendorId?.trim() ?? "",
    createdBy: currentUser.id,
  });

  await insertActivity({
    actorUserId: currentUser.id,
    actorEmail: currentUser.email,
    actorRole: currentUser.role,
    regionId: currentUser.regionId,
    eventType: "ENGINEER_CREATED",
    targetType: "engineer",
    targetId: engineer.id,
    ipAddress: null,
    userAgent: null,
    metadata: { engineerName: engineer.engineerName, engineerCode: engineer.engineerCode },
    status: "SUCCESS",
  });

  return engineer;
}

export interface UpdateEngineerServiceInput {
  engineerCode?: string | null;
  engineerName?: string;
  regionId?: string;
  email?: string | null;
  phone?: string | null;
  hpId?: string;
  vendorId?: string;
}

export async function updateEngineerService(
  currentUser: AuthenticatedUser,
  id: string,
  input: UpdateEngineerServiceInput,
): Promise<Engineer> {
  const existing = await findEngineerById(id);
  if (!existing) {
    throw notFound("Engineer not found");
  }

  assertRegionAccess(currentUser, existing.regionId);
  if (input.regionId && input.regionId !== existing.regionId) {
    assertRegionAccess(currentUser, input.regionId);
  }

  const updateData: Parameters<typeof updateEngineer>[1] = {
    updatedBy: currentUser.id,
  };
  if (input.engineerCode !== undefined) updateData.engineerCode = input.engineerCode;
  if (input.engineerName !== undefined) updateData.engineerName = input.engineerName.trim();
  if (input.regionId !== undefined) updateData.regionId = input.regionId;
  if (input.email !== undefined) updateData.email = input.email;
  if (input.phone !== undefined) updateData.phone = input.phone;
  if (input.hpId !== undefined) updateData.hpId = input.hpId.trim();
  if (input.vendorId !== undefined) updateData.vendorId = input.vendorId.trim();

  const updated = await updateEngineer(id, updateData);

  if (!updated) {
    throw notFound("Engineer not found");
  }

  await insertActivity({
    actorUserId: currentUser.id,
    actorEmail: currentUser.email,
    actorRole: currentUser.role,
    regionId: currentUser.regionId,
    eventType: "ENGINEER_UPDATED",
    targetType: "engineer",
    targetId: id,
    ipAddress: null,
    userAgent: null,
    metadata: { changes: Object.keys(input) },
    status: "SUCCESS",
  });

  return updated;
}

export async function setEngineerActiveService(
  currentUser: AuthenticatedUser,
  id: string,
  isActive: boolean,
): Promise<Engineer> {
  const existing = await findEngineerById(id);
  if (!existing) {
    throw notFound("Engineer not found");
  }

  assertRegionAccess(currentUser, existing.regionId);

  if (existing.isActive === isActive) {
    return existing;
  }

  const updated = await setEngineerActive(id, isActive, currentUser.id);
  if (!updated) {
    throw notFound("Engineer not found");
  }

  await insertActivity({
    actorUserId: currentUser.id,
    actorEmail: currentUser.email,
    actorRole: currentUser.role,
    regionId: currentUser.regionId,
    eventType: isActive ? "ENGINEER_UPDATED" : "ENGINEER_DEACTIVATED",
    targetType: "engineer",
    targetId: id,
    ipAddress: null,
    userAgent: null,
    metadata: { isActive },
    status: "SUCCESS",
  });

  return updated;
}
