// Per-region "Final EOD" day boundary for engineer productivity.
//
// Closing a region's day computes that region's productivity from the day's
// PERSISTED report rows via the SAME shared function the live dashboard runs
// (computeEngineerProductivity), persists it as a frozen snapshot and marks
// the region-day CLOSED. Edits made afterwards no longer change the frozen
// day — they roll into the region's next working day, whose plan is computed
// from the next day's report. A SUPER_ADMIN can reopen a mistakenly-closed
// region-day (snapshot deleted, region live again).
//
// INVARIANT: everything in this service is READ-ONLY with respect to the
// day's report. Closing a day must never regenerate it — regenerating from a
// region-scoped Flex batch mass-closes every other region's calls (the
// 2026-07-23 incident).
import {
  computeEngineerProductivity,
  type EngineerProductivityResult,
  type ProductivityReportRow,
  type RegionEodStateEntry,
  type RegionEodStateResponse,
  type RegionProductivityEntry,
  type ReportProductivityResponse,
} from "@opencall/shared";
import { withTransaction } from "../../config/database.js";
import {
  findProductivityRowsByReportId,
  type ProductivityPersistedRow,
} from "../../repositories/dailyCallPlanReportRepository.js";
import { findLatestCompletedSessionByReportDate } from "../../repositories/historyRepository.js";
import {
  deleteProductivitySnapshot,
  findEodStateForUpdate,
  findEodStatesForDate,
  findSnapshot,
  findSnapshotsForDate,
  markRegionEodClosed,
  markRegionEodOpen,
  upsertProductivitySnapshot,
  type RegionEodStateRecord,
} from "../../repositories/regionEodRepository.js";
import {
  findRegionById,
  listRegions,
  type Region,
} from "../../repositories/regionRepository.js";
import type { AuthenticatedUser } from "../../types/auth.js";
import { forbidden, unprocessableEntity } from "../../utils/httpError.js";
import { findAllowedRegionsForUser } from "../rbac/regionAccessService.js";
import { aspCodesForRegion } from "../rbac/regionRowAccess.js";

const WORKING_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertValidWorkingDate(workingDate: string): void {
  if (!WORKING_DATE_PATTERN.test(workingDate)) {
    throw unprocessableEntity("workingDate must be a YYYY-MM-DD date", {
      workingDate,
    });
  }
}

/**
 * The region this user may Final-EOD: a REGION_ADMIN only their own managed
 * region(s); a SUPER_ADMIN any region.
 */
async function authorizeRegionDayAccess(
  user: AuthenticatedUser,
  regionId: string,
): Promise<Region> {
  const region = await findRegionById(regionId);
  if (!region) {
    throw unprocessableEntity("Region not found", { regionId });
  }

  if (user.role === "SUPER_ADMIN") {
    return region;
  }

  const allowedRegions = await findAllowedRegionsForUser(user);
  if (!allowedRegions || !allowedRegions.some((r) => r.id === regionId)) {
    throw forbidden("REGION_ADMIN cannot Final-EOD another region", {
      regionId,
      userRegionId: user.regionId,
    });
  }

  return region;
}

/** Shared-calc row shape from a persisted report row (explicit, cast-free). */
function toProductivityRow(row: ProductivityPersistedRow): ProductivityReportRow {
  return {
    serialNo: row.serialNo,
    output: {
      "Ticket ID": row.ticketId,
      Engineer: row.engineer,
      "RTPL status": row.rtplStatus,
      "Evening status": row.eveningRtplStatus,
      "Work Location": row.workLocation,
      "Flex Status": row.flexStatus,
    },
    carryForward: {
      closedSyntheticRow: row.closedSyntheticRow,
      sameDayClosedRow: row.sameDayClosedRow,
    },
    comparison: null,
  };
}

/**
 * The day's rows as PERSISTED for the latest completed session — strictly
 * READ-ONLY. This must never regenerate the report: regeneration rewrites
 * every region's rows from a single Flex batch, and when that batch is
 * region-scoped it mass-closes every other region's calls (the 2026-07-23
 * incident, triggered by exactly this close path). The persisted rows are
 * also what the admin is looking at when they click Final EOD, so the frozen
 * numbers match the screen by construction.
 */
async function loadDayProductivityRows(
  workingDate: string,
): Promise<ProductivityReportRow[]> {
  const session = await findLatestCompletedSessionByReportDate(workingDate);
  if (!session?.daily_call_plan_report_id) {
    throw unprocessableEntity(
      "No completed report exists for this working date",
      { workingDate },
    );
  }

  const rows = await findProductivityRowsByReportId(
    session.daily_call_plan_report_id,
  );
  return rows.map(toProductivityRow);
}

function computeRegionProductivity(
  rows: readonly ProductivityReportRow[],
  region: Region,
): EngineerProductivityResult {
  return computeEngineerProductivity(rows, {
    regionAspCodes: [...aspCodesForRegion(region)],
  });
}

export interface CloseRegionEodResult {
  state: RegionEodStateRecord;
  snapshot: EngineerProductivityResult;
  /** false when the region-day was already closed (idempotent no-op). */
  frozenNow: boolean;
}

export async function closeRegionEod(
  user: AuthenticatedUser,
  regionId: string,
  workingDate: string,
): Promise<CloseRegionEodResult> {
  assertValidWorkingDate(workingDate);
  const region = await authorizeRegionDayAccess(user, regionId);

  // Idempotency pre-check: a second click must NOT recompute — the frozen
  // numbers of the first close stand.
  const existingStates = await findEodStatesForDate(workingDate);
  const existingState = existingStates.find((s) => s.regionId === regionId);
  if (existingState?.status === "CLOSED") {
    const snapshots = await findSnapshotsForDate(workingDate);
    const snapshot = snapshots.find((s) => s.regionId === regionId);
    if (snapshot) {
      return { state: existingState, snapshot: snapshot.payload, frozenNow: false };
    }
  }

  // Compute the freeze OUTSIDE the state transaction, from the day's
  // persisted rows — the close is read-only with respect to the report.
  const rows = await loadDayProductivityRows(workingDate);
  const productivity = computeRegionProductivity(rows, region);

  return withTransaction(async (client) => {
    // Re-check under the row lock: if another request closed the day while we
    // were computing, keep ITS snapshot (first close wins).
    const lockedState = await findEodStateForUpdate(client, regionId, workingDate);
    if (lockedState?.status === "CLOSED") {
      const snapshot = await findSnapshot(client, regionId, workingDate);
      if (snapshot) {
        return { state: lockedState, snapshot: snapshot.payload, frozenNow: false };
      }
    }

    await upsertProductivitySnapshot(client, regionId, workingDate, productivity);
    const state = await markRegionEodClosed(client, regionId, workingDate, user.id);
    return { state, snapshot: productivity, frozenNow: true };
  });
}

export interface ReopenRegionEodResult {
  state: RegionEodStateRecord | null;
  reopened: boolean;
}

export async function reopenRegionEod(
  user: AuthenticatedUser,
  regionId: string,
  workingDate: string,
): Promise<ReopenRegionEodResult> {
  assertValidWorkingDate(workingDate);

  if (user.role !== "SUPER_ADMIN") {
    throw forbidden("Only SUPER_ADMIN can reopen a closed region day", {
      regionId,
      workingDate,
    });
  }

  const region = await findRegionById(regionId);
  if (!region) {
    throw unprocessableEntity("Region not found", { regionId });
  }

  return withTransaction(async (client) => {
    const lockedState = await findEodStateForUpdate(client, regionId, workingDate);
    if (!lockedState || lockedState.status === "OPEN") {
      // Nothing to reopen — idempotent no-op.
      return { state: lockedState ?? null, reopened: false };
    }

    await deleteProductivitySnapshot(client, regionId, workingDate);
    const state = await markRegionEodOpen(client, regionId, workingDate);
    return { state, reopened: true };
  });
}

/**
 * OPEN/CLOSED per region for a working date, with each closed region's frozen
 * snapshot so clients render frozen numbers instead of a live compute.
 */
export async function getRegionEodState(
  workingDate: string,
): Promise<RegionEodStateResponse> {
  assertValidWorkingDate(workingDate);

  const [regions, states, snapshots] = await Promise.all([
    listRegions({ activeOnly: true }),
    findEodStatesForDate(workingDate),
    findSnapshotsForDate(workingDate),
  ]);

  const stateByRegion = new Map(states.map((s) => [s.regionId, s]));
  const snapshotByRegion = new Map(snapshots.map((s) => [s.regionId, s]));

  const entries: RegionEodStateEntry[] = regions.map((region) => {
    const state = stateByRegion.get(region.id);
    const closed = state?.status === "CLOSED";
    return {
      regionId: region.id,
      regionCode: region.code,
      regionName: region.name,
      workingDate,
      status: closed ? "CLOSED" : "OPEN",
      closedAt: closed ? (state?.closedAt ?? null) : null,
      closedBy: closed ? (state?.closedByDisplay ?? null) : null,
      snapshot: closed ? (snapshotByRegion.get(region.id)?.payload ?? null) : null,
    };
  });

  return { workingDate, regions: entries };
}

/**
 * Per-region productivity for a report date: the frozen snapshot when the
 * region's day is CLOSED, else a live compute from the day's report — both
 * paths through the same shared function.
 */
export async function getReportProductivity(
  _user: AuthenticatedUser,
  workingDate: string,
): Promise<ReportProductivityResponse> {
  assertValidWorkingDate(workingDate);

  const [regions, states, snapshots] = await Promise.all([
    listRegions({ activeOnly: true }),
    findEodStatesForDate(workingDate),
    findSnapshotsForDate(workingDate),
  ]);
  const closedRegionIds = new Set(
    states.filter((s) => s.status === "CLOSED").map((s) => s.regionId),
  );
  const snapshotByRegion = new Map(snapshots.map((s) => [s.regionId, s]));

  // Read the day's persisted rows once only if any region still needs a live
  // compute; a fully-frozen day is served purely from snapshots.
  const liveRegions = regions.filter(
    (region) =>
      !closedRegionIds.has(region.id) || !snapshotByRegion.has(region.id),
  );
  const liveRows =
    liveRegions.length > 0 ? await loadDayProductivityRows(workingDate) : [];

  const entries: RegionProductivityEntry[] = regions.map((region) => {
    const frozen = closedRegionIds.has(region.id)
      ? snapshotByRegion.get(region.id)
      : undefined;
    return {
      regionId: region.id,
      regionCode: region.code,
      regionName: region.name,
      source: frozen ? "FROZEN" : "LIVE",
      productivity: frozen
        ? frozen.payload
        : computeRegionProductivity(liveRows, region),
    };
  });

  return { workingDate, regions: entries };
}
