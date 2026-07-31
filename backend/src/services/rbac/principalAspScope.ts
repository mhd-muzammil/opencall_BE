import type { Request } from "express";
import { findRegionById } from "../../repositories/regionRepository.js";
import { aspCodesForRegion } from "./regionRowAccess.js";

/**
 * The set of ASP (work-location) codes the request's principal is allowed to read
 * raw closed-call data for, or `null` when the principal is unrestricted.
 *
 * The Closed Calls raw-data and closure-date endpoints take an `asp` query param and
 * used to pass it straight to SQL, with `''` meaning "every region". That let any
 * principal — including a special-access credential scoped to two regions — read any
 * other region's closed cases just by changing the parameter. These endpoints are
 * reachable via `requirePrincipal`, so the scope has to be resolved for all three
 * principal kinds:
 *
 *   SUPER_ADMIN     -> null (unrestricted)
 *   REGION_ADMIN    -> its own region's ASP codes
 *   SPECIAL_ACCESS  -> null when `allRegions`, else the union of its granted regions
 *   VENDOR_ACCESS   -> empty set (vendors are case-assigned, never region-scoped)
 *
 * Returning `null` rather than "all codes" keeps the unrestricted path a no-op filter
 * instead of an ever-growing IN list.
 */
export async function allowedAspCodesForRequest(
  request: Request,
): Promise<Set<string> | null> {
  const special = request.specialAccess;
  if (special) {
    return special.allRegions ? null : collectAspCodes(special.regions);
  }

  const user = request.currentUser;
  if (user) {
    if (user.role === "SUPER_ADMIN") {
      return null;
    }
    const regionId = user.regionId ?? user.region_id;
    return collectAspCodes(regionId ? [regionId] : []);
  }

  // Vendor-access (or anything else that reached here) gets no region-scoped data.
  return new Set<string>();
}

async function collectAspCodes(
  regionIds: readonly string[],
): Promise<Set<string>> {
  const codes = new Set<string>();
  for (const regionId of regionIds) {
    const region = await findRegionById(regionId);
    if (!region) {
      continue;
    }
    for (const code of aspCodesForRegion(region)) {
      codes.add(code.trim().toUpperCase());
    }
  }
  return codes;
}

/** `null` (unrestricted) or the scope as a sorted array, for passing to SQL. */
export function aspScopeToArray(
  allowed: Set<string> | null,
): string[] | null {
  return allowed === null ? null : [...allowed].sort();
}
