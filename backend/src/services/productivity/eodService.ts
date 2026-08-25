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
  mergeEngineerProductivityResults,
  type EngineerProductivityResult,
  type ProductivityReportRow,
  type RegionEodStateEntry,
  type RegionEodStateResponse,
  type RegionProductivityEntry,
  type RegionProductivityRangeEntry,
  type ReportProductivityRangeResponse,
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
async function loadDayProductivityRowsOrNull(
  workingDate: string,
): Promise<ProductivityReportRow[] | null> {
  const session = await findLatestCompletedSessionByReportDate(workingDate);
  if (!session?.daily_call_plan_report_id) {
    return null;
  }

  const rows = await findProductivityRowsByReportId(
    session.daily_call_plan_report_id,
  );
  return rows.map(toProductivityRow);
}

/**
 * As above, but a day with no completed report is an error. Asking to close or
 * read ONE day that does not exist is a mistake worth reporting; a range that
 * happens to span such a day is not (see `getReportProductivityRange`).
 */
async function loadDayProductivityRows(
  workingDate: string,
): Promise<ProductivityReportRow[]> {
  const rows = await loadDayProductivityRowsOrNull(workingDate);
  if (rows === null) {
    throw unprocessableEntity(
      "No completed report exists for this working date",
      { workingDate },
    );
  }
  return rows;
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
  return freezeRegionDay(region, workingDate, user.id);
}

/**
 * Freezes an ALREADY-AUTHORIZED region's day. The caller is responsible for proving
 * the principal may close this region — everything downstream of that check lives
 * here so the idempotency and first-close-wins guarantees (added after the
 * 2026-07-23 mass-close incident) exist in exactly one place, shared by the regular
 * user route and the special-access route.
 *
 * `closedBy` is a `users.id`, or null for a special-access credential: those are not
 * `users` rows and `region_eod_state.closed_by` is an FK to `users(id)`.
 */
export async function freezeRegionDay(
  region: Region,
  workingDate: string,
  closedBy: string | null,
): Promise<CloseRegionEodResult> {
  assertValidWorkingDate(workingDate);
  const regionId = region.id;

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
    const state = await markRegionEodClosed(client, regionId, workingDate, closedBy);
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
/**
 * One day's per-region productivity against an already-loaded region list.
 * Returns null when the day has no completed report at all AND some region
 * would have needed a live compute from it — a fully-frozen day still answers.
 *
 * Shared by the single-day endpoint and the range endpoint so a range is
 * literally the sum of the days the single-day view would show.
 */
async function productivityEntriesForDay(
  workingDate: string,
  regions: readonly Region[],
): Promise<RegionProductivityEntry[] | null> {
  const [states, snapshots] = await Promise.all([
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
  let liveRows: ProductivityReportRow[] = [];
  if (liveRegions.length > 0) {
    const rows = await loadDayProductivityRowsOrNull(workingDate);
    if (rows === null) return null;
    liveRows = rows;
  }

  return regions.map((region) => {
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
}

export async function getReportProductivity(
  workingDate: string,
): Promise<ReportProductivityResponse> {
  assertValidWorkingDate(workingDate);

  const regions = await listRegions({ activeOnly: true });
  const entries = await productivityEntriesForDay(workingDate, regions);
  if (entries === null) {
    throw unprocessableEntity(
      "No completed report exists for this working date",
      { workingDate },
    );
  }

  return { workingDate, regions: entries };
}

/**
 * The most days one range request will read. Each day costs its report's rows,
 * so an unbounded range is an unbounded query — a quarter covers any bill cycle
 * or month the productivity filter can ask for, and anything longer is refused
 * out loud instead of quietly timing out.
 */
const MAX_PRODUCTIVITY_RANGE_DAYS = 92;

/** How many days are read at once. Bounds concurrent row loads on the pool. */
const RANGE_DAY_CONCURRENCY = 4;

/** Every YYYY-MM-DD from `from` to `to` inclusive, walked in UTC. */
function enumerateWorkingDates(from: string, to: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Per-region productivity summed over an inclusive range of working dates.
 *
 * Productivity is day-scoped by construction — assigned is THAT day's plan,
 * attended and closed are THAT day's outcomes — so the only faithful reading of
 * "Jun 25 to Jul 24" is each of those days computed exactly as its own day and
 * added together. Every day goes through `productivityEntriesForDay`, so a range
 * and the days it is made of can never disagree, and a Final-EOD-frozen day
 * contributes its frozen snapshot here too.
 *
 * A date with no completed report contributes nothing and is reported in
 * `missingDays`; it is not an error, or no range spanning a quiet day could ever
 * be asked for.
 */
export async function getReportProductivityRange(
  fromRaw: string,
  toRaw: string,
): Promise<ReportProductivityRangeResponse> {
  assertValidWorkingDate(fromRaw);
  assertValidWorkingDate(toRaw);
  // A reversed pair is a slip, not a request for nothing.
  const [from, to] = fromRaw <= toRaw ? [fromRaw, toRaw] : [toRaw, fromRaw];

  const dates = enumerateWorkingDates(from, to);
  if (dates.length > MAX_PRODUCTIVITY_RANGE_DAYS) {
    throw unprocessableEntity(
      `A productivity range covers at most ${MAX_PRODUCTIVITY_RANGE_DAYS} days`,
      { from, to, days: dates.length },
    );
  }

  const regions = await listRegions({ activeOnly: true });

  const days: string[] = [];
  const missingDays: string[] = [];
  const perRegion = new Map<
    string,
    { frozen: number; live: number; results: EngineerProductivityResult[] }
  >();

  for (let i = 0; i < dates.length; i += RANGE_DAY_CONCURRENCY) {
    const batch = dates.slice(i, i + RANGE_DAY_CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (date) => ({
        date,
        entries: await productivityEntriesForDay(date, regions),
      })),
    );

    for (const { date, entries } of settled) {
      if (entries === null) {
        missingDays.push(date);
        continue;
      }
      days.push(date);
      for (const entry of entries) {
        let bucket = perRegion.get(entry.regionId);
        if (!bucket) {
          bucket = { frozen: 0, live: 0, results: [] };
          perRegion.set(entry.regionId, bucket);
        }
        if (entry.source === "FROZEN") bucket.frozen += 1;
        else bucket.live += 1;
        bucket.results.push(entry.productivity);
      }
    }
  }

  days.sort();
  missingDays.sort();

  const entries: RegionProductivityRangeEntry[] = regions.map((region) => {
    const bucket = perRegion.get(region.id);
    return {
      regionId: region.id,
      regionCode: region.code,
      regionName: region.name,
      source:
        !bucket || bucket.frozen === 0
          ? "LIVE"
          : bucket.live === 0
            ? "FROZEN"
            : "MIXED",
      productivity: mergeEngineerProductivityResults(bucket?.results ?? []),
    };
  });

  return { from, to, days, missingDays, regions: entries };
}
