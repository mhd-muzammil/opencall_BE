import type { AuthenticatedUser } from "../../types/auth.js";
import { withTransaction } from "../../config/database.js";
import { forbidden, notFound, badRequest } from "../../utils/httpError.js";
import { insertActivity } from "../../repositories/activityLogRepository.js";
import {
  deleteEngineer,
  findEngineerById,
  findEngineerByNameInRegion,
  insertEngineer,
  listEngineers,
  listEngineersForDropdown,
  renameEngineerInHistoricalRows,
  setEngineerActive,
  updateEngineer,
  type Engineer,
  type ListEngineersFilters,
  type ListEngineersResult,
  type DropdownEngineer,
  type RenameEngineerHistoryCounts,
} from "../../repositories/engineerRepository.js";
import { findRegionById } from "../../repositories/regionRepository.js";
import { aspCodesForRegion } from "../rbac/regionRowAccess.js";

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

export interface UpdateEngineerServiceResult {
  engineer: Engineer;
  /**
   * How many historical call/report row values were remapped from the old
   * name to the new one when this update renamed the engineer. Both zero when
   * nothing was renamed.
   */
  remappedHistory: RenameEngineerHistoryCounts;
}

export async function updateEngineerService(
  currentUser: AuthenticatedUser,
  id: string,
  input: UpdateEngineerServiceInput,
): Promise<UpdateEngineerServiceResult> {
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

  // A rename (any change to the stored name, including casing-only fixes)
  // must remap the historical call/report rows that store the engineer as a
  // name string, else filters show the same person twice (old-name cases vs
  // new-name cases). Scoped to the engineer's CURRENT region — that is where
  // the historical rows live, and it protects a same-named engineer elsewhere.
  const isRename =
    updateData.engineerName !== undefined &&
    updateData.engineerName !== existing.engineerName;

  if (isRename) {
    if (!updateData.engineerName) {
      throw badRequest("engineerName cannot be empty");
    }
    // Collision guard: if ANOTHER engineer in this region already carries the
    // new name, remapping would merge two people's case history — refuse.
    const collision = await findEngineerByNameInRegion(
      updateData.engineerName,
      existing.regionId,
      id,
    );
    if (collision) {
      throw badRequest(
        `Another engineer named "${collision.engineerName}" already exists in this region. ` +
          `Renaming would merge their case history — pick a different name or delete the duplicate first.`,
      );
    }
  }

  const renameScope = isRename
    ? await (async () => {
        const region = await findRegionById(existing.regionId);
        return {
          regionId: existing.regionId,
          aspCodes: region ? [...aspCodesForRegion(region)] : [],
        };
      })()
    : null;

  // One transaction: the engineers-row update and the historical remap
  // succeed or fail together.
  const { updated, remappedHistory } = await withTransaction(async (client) => {
    const updatedRow = await updateEngineer(id, updateData, client);
    if (!updatedRow) {
      throw notFound("Engineer not found");
    }

    let counts: RenameEngineerHistoryCounts = { reportRows: 0, callPlanRecords: 0 };
    if (isRename && renameScope) {
      counts = await renameEngineerInHistoricalRows(
        client,
        existing.engineerName,
        updateData.engineerName!,
        renameScope,
      );
    }
    return { updated: updatedRow, remappedHistory: counts };
  });

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
    metadata: isRename
      ? {
          changes: Object.keys(input),
          renamedFrom: existing.engineerName,
          renamedTo: updateData.engineerName,
          remappedReportRows: remappedHistory.reportRows,
          remappedCallPlanRecords: remappedHistory.callPlanRecords,
        }
      : { changes: Object.keys(input) },
    status: "SUCCESS",
  });

  return { engineer: updated, remappedHistory };
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

/**
 * Hard-deletes an engineer record. Safe by schema: no table has a foreign key
 * to engineers, and historical call/report rows store the engineer as a NAME
 * string, so past cases keep their engineer attribution after the record is
 * gone. Region admins can only delete engineers in their own region.
 */
export async function deleteEngineerService(
  currentUser: AuthenticatedUser,
  id: string,
): Promise<void> {
  const existing = await findEngineerById(id);
  if (!existing) {
    throw notFound("Engineer not found");
  }

  assertRegionAccess(currentUser, existing.regionId);

  const deleted = await deleteEngineer(id);
  if (!deleted) {
    throw notFound("Engineer not found");
  }

  await insertActivity({
    actorUserId: currentUser.id,
    actorEmail: currentUser.email,
    actorRole: currentUser.role,
    regionId: currentUser.regionId,
    eventType: "ENGINEER_DELETED",
    targetType: "engineer",
    targetId: id,
    ipAddress: null,
    userAgent: null,
    metadata: {
      engineerName: existing.engineerName,
      engineerCode: existing.engineerCode,
      regionId: existing.regionId,
    },
    status: "SUCCESS",
  });
}
