import type { AuthenticatedUser } from "../../types/auth.js";
import type { UploadBatchValidationRecord } from "../../repositories/uploadBatchRepository.js";
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
