import type { RequestHandler } from "express";
import { listRegions, type Region } from "../repositories/regionRepository.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import { dedupeRegionsByName } from "../services/rbac/regionGroups.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Some region names (notably "Chennai") have multiple rows in the regions
// table — one with the ASP code, one with a short code — for historical
// reasons. Admin dropdowns must surface only the canonical record per name;
// otherwise users see duplicate entries and filter selections become
// ambiguous. We collapse here at the API boundary so every page that lists
// regions stays consistent.
function canonicalRegionsForRole(
  allRegions: Region[],
  user: { role: string; regionId: string | null },
): Region[] {
  const groups = dedupeRegionsByName(allRegions);
  const canonical = groups.map((g) => g.canonical);

  if (user.role === "SUPER_ADMIN") {
    return canonical;
  }

  // REGION_ADMIN sees only their own canonical region. A REGION_ADMIN may be
  // assigned to a non-canonical row (e.g. Chennai short-code) — match by
  // membership in the group, not by region.id, so they still see their
  // canonical entry rather than nothing.
  if (!user.regionId) return [];
  const ownGroup = groups.find((g) => g.regionIds.has(user.regionId!));
  return ownGroup ? [ownGroup.canonical] : [];
}

export const listAdminRegionsController: RequestHandler = asyncHandler(
  async (request, response) => {
    const user = requireCurrentUser(request.currentUser);
    const allRegions = await listRegions();
    const visibleRegions = canonicalRegionsForRole(allRegions, user);
    response.json({ data: visibleRegions });
  },
);
