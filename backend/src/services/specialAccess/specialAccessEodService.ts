import type { SpecialAccessPrincipal } from "../../types/auth.js";
import type { Region } from "../../repositories/regionRepository.js";
import { findRegionById } from "../../repositories/regionRepository.js";
import type {
  RegionEodStateResponse,
  ReportProductivityRangeResponse,
} from "@opencall/shared";
import {
  freezeRegionDay,
  getRegionEodState,
  getReportProductivityRange,
  type CloseRegionEodResult,
} from "../productivity/eodService.js";
import { forbidden, unprocessableEntity } from "../../utils/httpError.js";

/**
 * Final-EOD for special-access credentials.
 *
 * A REGION_ADMIN may freeze their own region's day; the faithful equivalent for a
 * special-access credential is "may freeze any of its GRANTED regions' days". Two
 * extra conditions apply, because a special-access credential is a scoped login
 * rather than a role:
 *
 *   - `permissionLevel` must be `edit`. A view-only credential never writes.
 *   - the `productivity` section must be granted, since Final EOD freezes exactly
 *     that view's numbers for the day.
 *
 * The freeze itself goes through the shared `freezeRegionDay`, so the idempotency
 * and first-close-wins guarantees are identical to the regular user path.
 */

/** Regions this credential may act on, or `null` when it is granted all regions. */
function grantedRegionIds(principal: SpecialAccessPrincipal): Set<string> | null {
  return principal.allRegions ? null : new Set(principal.regions);
}

function assertMayCloseEod(principal: SpecialAccessPrincipal): void {
  if (principal.permissionLevel !== "edit") {
    throw forbidden("This login has view-only access and cannot Final-EOD a region");
  }
  if (!principal.sections.includes("productivity")) {
    throw forbidden("Engineer Productivity is not granted to this login");
  }
}

async function authorizeGrantedRegion(
  principal: SpecialAccessPrincipal,
  regionId: string,
): Promise<Region> {
  const region = await findRegionById(regionId);
  if (!region) {
    throw unprocessableEntity("Region not found", { regionId });
  }

  const granted = grantedRegionIds(principal);
  if (granted && !granted.has(regionId)) {
    throw forbidden("This login cannot Final-EOD a region it was not granted", {
      regionId,
    });
  }

  return region;
}

/**
 * The per-region EOD state for a working date, filtered to the credential's granted
 * regions. Mirrors GET /reports/:date/eod-state, which is role-guarded and therefore
 * unreachable with a special-access token — without it the productivity view had no
 * idea which regions were frozen and silently showed live numbers for closed days.
 */
export async function getRegionEodStateForSpecialAccess(
  principal: SpecialAccessPrincipal,
  workingDate: string,
): Promise<RegionEodStateResponse> {
  const state = await getRegionEodState(workingDate);
  const granted = grantedRegionIds(principal);
  if (!granted) {
    return state;
  }
  return {
    ...state,
    regions: state.regions.filter((region) => granted.has(region.regionId)),
  };
}

/**
 * Productivity summed across a date range, filtered to the credential's granted
 * regions. Mirrors GET /reports/productivity/range, which is role-guarded and so
 * unreachable with a special-access token — without it the date-range filter would
 * keep reading a single day's report for exactly the logins that cannot fetch the
 * range any other way.
 */
export async function getReportProductivityRangeForSpecialAccess(
  principal: SpecialAccessPrincipal,
  from: string,
  to: string,
): Promise<ReportProductivityRangeResponse> {
  if (!principal.sections.includes("productivity")) {
    throw forbidden("Engineer Productivity is not granted to this login");
  }
  const range = await getReportProductivityRange(from, to);
  const granted = grantedRegionIds(principal);
  if (!granted) {
    return range;
  }
  return {
    ...range,
    regions: range.regions.filter((region) => granted.has(region.regionId)),
  };
}

export async function closeRegionEodForSpecialAccess(
  principal: SpecialAccessPrincipal,
  regionId: string,
  workingDate: string,
): Promise<CloseRegionEodResult> {
  assertMayCloseEod(principal);
  const region = await authorizeGrantedRegion(principal, regionId);
  // closedBy is null: the credential is not a `users` row (FK), and the activity
  // log records which special-access login actually did it.
  return freezeRegionDay(region, workingDate, null);
}
