import {
  listEngineersForDropdown,
  type DropdownEngineer,
} from "../../repositories/engineerRepository.js";
import type { DropdownRtplStatus } from "../../repositories/rtplStatusRepository.js";
import { getRtplStatusesDropdownService } from "../rtplStatuses/rtplStatusService.js";
import type { SpecialAccessPrincipal } from "../../types/auth.js";

/**
 * Reference data the Work Order Details & Entry modal needs: the engineer list and the
 * admin-managed RTPL status list.
 *
 * A special-access credential is NOT a row in `users`, so it can never satisfy the
 * `requireRole(["SUPER_ADMIN","REGION_ADMIN"])` guard on the admin dropdown endpoints —
 * those calls 401 for it. Without these the modal opened with an EMPTY engineer dropdown
 * and silently fell back to the hard-coded RTPL status list instead of the one the admin
 * actually manages, so a special-access login could not fill the entry form the way a
 * regular user can.
 *
 * These are the scoped equivalents, mirroring how `record-layout` already has a
 * special-access variant. Read-only; no write path and no admin capability is exposed.
 */

/**
 * Active engineers the credential may pick from: every region when `allRegions`, otherwise
 * the union across its granted regions.
 *
 * The regular-user service takes a single region id, so the multi-region case is a small
 * fan-out (a credential has at most a handful of regions) and the result is de-duplicated
 * and re-sorted by name to read exactly like the single-region list.
 */
export async function getEngineersDropdownForSpecialAccess(
  principal: SpecialAccessPrincipal,
): Promise<DropdownEngineer[]> {
  if (principal.allRegions) {
    return listEngineersForDropdown(null);
  }

  if (principal.regions.length === 0) {
    return [];
  }

  const byId = new Map<string, DropdownEngineer>();
  for (const regionId of principal.regions) {
    for (const engineer of await listEngineersForDropdown(regionId)) {
      byId.set(engineer.id, engineer);
    }
  }

  return [...byId.values()].sort((a, b) =>
    a.engineerName.localeCompare(b.engineerName),
  );
}

/**
 * The admin-managed RTPL status list. Global for regular users (the admin route's own
 * comment says so), so it is global here too — a status is a vocabulary entry, not data.
 */
export async function getRtplStatusesDropdownForSpecialAccess(): Promise<
  DropdownRtplStatus[]
> {
  return getRtplStatusesDropdownService();
}
