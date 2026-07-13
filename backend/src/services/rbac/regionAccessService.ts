import type { AuthenticatedUser } from "../../types/auth.js";
import type { UploadBatchValidationRecord } from "../../repositories/uploadBatchRepository.js";
import {
  findRegionById,
  type Region,
} from "../../repositories/regionRepository.js";
import { findAdditionalRegionIdsForUser } from "../../repositories/userRegionRepository.js";
import { forbidden } from "../../utils/httpError.js";

export function requireCurrentUser(
  user: AuthenticatedUser | undefined,
): AuthenticatedUser {
  if (!user) {
    throw forbidden("Authenticated user context is missing");
  }

  return user;
}

export function resolveEffectiveRegionId(
  user: AuthenticatedUser,
  requestedRegionId: string | null | undefined,
): string | null {
  const normalizedRegionId = requestedRegionId?.trim() || null;

  if (user.role === "SUPER_ADMIN") {
    return normalizedRegionId;
  }

  if (!user.regionId) {
    throw forbidden("REGION_ADMIN user is not assigned to a region");
  }

  if (normalizedRegionId && normalizedRegionId !== user.regionId) {
    throw forbidden("REGION_ADMIN cannot access another region", {
      requestedRegionId: normalizedRegionId,
      userRegionId: user.regionId,
    });
  }

  return user.regionId;
}

export function assertCanAccessBatchRegions(
  user: AuthenticatedUser,
  batches: readonly UploadBatchValidationRecord[],
): void {
  if (user.role === "SUPER_ADMIN") {
    return;
  }

  if (!user.regionId) {
    throw forbidden("REGION_ADMIN user is not assigned to a region");
  }

  const blockedBatches = batches.filter((batch) => {
    if (batch.uploaderRole === "SUPER_ADMIN") {
      return false;
    }
    return batch.regionId !== null && batch.regionId !== user.regionId;
  });

  if (blockedBatches.length > 0) {
    throw forbidden("REGION_ADMIN cannot access upload batches from another region", {
      blockedBatchIds: blockedBatches.map((batch) => batch.id),
      userRegionId: user.regionId,
    });
  }
}

/**
 * Every region this user may affect. null = unrestricted (SUPER_ADMIN).
 * A REGION_ADMIN gets their primary region plus any user_regions rows.
 */
export async function findAllowedRegionsForUser(
  user: AuthenticatedUser,
): Promise<Region[] | null> {
  if (user.role === "SUPER_ADMIN") {
    return null;
  }

  const regionIds = new Set<string>();
  if (user.regionId) {
    regionIds.add(user.regionId);
  }
  const additionalRegionIds = await findAdditionalRegionIdsForUser(user.id);
  for (const regionId of additionalRegionIds) {
    regionIds.add(regionId);
  }

  const regions: Region[] = [];
  for (const regionId of regionIds) {
    // findRegionById does not filter on is_active, so neither do we — an
    // assigned-but-inactive region stays visible, consistent with the rest
    // of the region lookups.
    const region = await findRegionById(regionId);
    if (region) {
      regions.push(region);
    }
  }

  if (regions.length === 0) {
    throw forbidden("REGION_ADMIN user is not assigned to a region");
  }

  return regions;
}
