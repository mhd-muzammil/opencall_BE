import type { AuthenticatedUser } from "../../types/auth.js";
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

/**
 * THE single authority on region membership: the region ids this user may see
 * AND affect. null = unrestricted (SUPER_ADMIN). A REGION_ADMIN gets their
 * primary region plus any user_regions rows, deduped, primary first.
 *
 * Both findAllowedRegionsForUser (read/visibility) and resolveEffectiveRegionId
 * (write/action) derive from this function, so the two paths can never drift
 * apart again. Never throws — an unassigned REGION_ADMIN yields []; callers
 * decide whether that is a 403 (actions) or an empty view (/me).
 */
export async function findAllowedRegionIdsForUser(
  user: AuthenticatedUser,
): Promise<string[] | null> {
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

  return [...regionIds];
}

/**
 * The region a write/action request is allowed to target. SUPER_ADMIN passes
 * through unrestricted; a REGION_ADMIN may target ANY of their allowed regions
 * (primary or additional), defaults to the primary when none is requested, and
 * is rejected with 403 for a region they do not hold.
 */
export async function resolveEffectiveRegionId(
  user: AuthenticatedUser,
  requestedRegionId: string | null | undefined,
): Promise<string | null> {
  const normalizedRegionId = requestedRegionId?.trim() || null;

  if (user.role === "SUPER_ADMIN") {
    return normalizedRegionId;
  }

  // No explicit region: default to the primary, exactly as before.
  if (!normalizedRegionId) {
    if (!user.regionId) {
      throw forbidden("REGION_ADMIN user is not assigned to a region");
    }
    return user.regionId;
  }

  // Fast path: the primary region needs no user_regions lookup — it is what
  // every single-region admin sends on every request.
  if (normalizedRegionId === user.regionId) {
    return normalizedRegionId;
  }

  const allowedRegionIds = (await findAllowedRegionIdsForUser(user)) ?? [];
  if (allowedRegionIds.length === 0) {
    throw forbidden("REGION_ADMIN user is not assigned to a region");
  }
  if (allowedRegionIds.includes(normalizedRegionId)) {
    return normalizedRegionId;
  }

  throw forbidden("REGION_ADMIN cannot access another region", {
    requestedRegionId: normalizedRegionId,
    userRegionId: user.regionId,
    allowedRegionIds,
  });
}

/**
 * Every region this user may affect, as full Region rows. null = unrestricted
 * (SUPER_ADMIN). Membership comes from findAllowedRegionIdsForUser — this
 * function only resolves ids to rows.
 */
export async function findAllowedRegionsForUser(
  user: AuthenticatedUser,
): Promise<Region[] | null> {
  const regionIds = await findAllowedRegionIdsForUser(user);
  if (regionIds === null) {
    return null;
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
