import {
  isCustomRowKey,
  isStatusBucket,
  lockedStatusBucket,
  STATUS_BUCKET_LABELS,
  type StatusBucket,
} from "@opencall/shared";
import type { AuthenticatedUser } from "../../types/auth.js";
import { badRequest, conflict, notFound } from "../../utils/httpError.js";
import { insertActivity } from "../../repositories/activityLogRepository.js";
import {
  deleteRtplStatus,
  findRtplStatusById,
  findRtplStatusByName,
  insertRtplStatus,
  listRtplStatusBuckets,
  listRtplStatuses,
  listRtplStatusesForDropdown,
  renameRtplStatusValueInReportRows,
  setRtplStatusActive,
  updateRtplStatus,
  type DropdownRtplStatus,
  type ListRtplStatusesFilters,
  type RtplStatus,
} from "../../repositories/rtplStatusRepository.js";
import { invalidateStatusBuckets } from "./statusBucketCache.js";
import { findBodEodCustomRowByKey } from "../../repositories/bodEodCustomRowRepository.js";

const MAX_NAME_LENGTH = 200;
const MAX_CATEGORY_LENGTH = 100;

/** Postgres unique-violation error code. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

function normalizeCategory(category: string | null | undefined): string {
  const value = (category ?? "Other").trim();
  if (!value) return "Other";
  if (value.length > MAX_CATEGORY_LENGTH) {
    throw badRequest(`category must be ${MAX_CATEGORY_LENGTH} characters or fewer`);
  }
  return value;
}

function normalizeName(name: string): string {
  const value = name.trim();
  if (!value) {
    throw badRequest("name is required");
  }
  if (value.length > MAX_NAME_LENGTH) {
    throw badRequest(`name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }
  return value;
}

/**
 * A built-in row, or a custom row an admin created. A hidden custom row cannot
 * be newly chosen, but a status already on it may keep it (`current`).
 */
async function normalizeBucket(bucket: unknown, current?: string | null): Promise<string> {
  if (isStatusBucket(bucket)) return bucket;
  if (isCustomRowKey(bucket)) {
    const row = await findBodEodCustomRowByKey(bucket);
    if (row && (row.isActive || bucket === current)) return bucket;
  }
  throw badRequest("Choose which BOD/EOD row this status counts under");
}

/**
 * "Scheduled", "Customer Pending" and the closure statuses are matched by their
 * exact name elsewhere (the plan gate, the KCI rule, closure reconciliation), so
 * they cannot be renamed, removed or moved to another row.
 */
function lockedMessage(name: string, bucket: StatusBucket): string {
  return `"${name}" is a system status (always counts under ${STATUS_BUCKET_LABELS[bucket]}) and cannot be renamed, moved, disabled or deleted`;
}

export async function getRtplStatusesDropdownService(): Promise<DropdownRtplStatus[]> {
  return listRtplStatusesForDropdown();
}

/** Postgres undefined_column: migration 068 has not been applied yet. */
const PG_UNDEFINED_COLUMN = "42703";

/**
 * Every status's BOD/EOD row, for the dashboards. Sent alongside the dropdown,
 * which every signed-in screen already polls. Before migration 068 there is no
 * mapping: answer empty (the dashboards fall back to keyword rules) rather than
 * fail the dropdown that every status picker depends on.
 */
export async function getRtplStatusBucketsService(): Promise<
  Array<{ name: string; bucket: string | null }>
> {
  try {
    return await listRtplStatusBuckets();
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === PG_UNDEFINED_COLUMN) {
      return [];
    }
    throw error;
  }
}

export async function listRtplStatusesService(
  filters: ListRtplStatusesFilters,
): Promise<RtplStatus[]> {
  return listRtplStatuses(filters);
}

export interface CreateRtplStatusInput {
  name: string;
  category?: string | null;
  sortOrder?: number | null;
  bodEodBucket?: unknown;
}

export async function createRtplStatusService(
  currentUser: AuthenticatedUser,
  input: CreateRtplStatusInput,
): Promise<RtplStatus> {
  const name = normalizeName(input.name);
  const category = normalizeCategory(input.category);
  // A system status always counts under its fixed row; every other new status
  // must say which row it belongs to — no more guessing from the name.
  const bodEodBucket = lockedStatusBucket(name) ?? (await normalizeBucket(input.bodEodBucket));

  const existing = await findRtplStatusByName(name);
  if (existing) {
    throw conflict("An RTPL status with this name already exists");
  }

  let status: RtplStatus;
  try {
    status = await insertRtplStatus({
      name,
      category,
      bodEodBucket,
      // null → append after existing statuses (see repository).
      sortOrder: input.sortOrder ?? null,
      createdBy: currentUser.id,
    });
  } catch (error) {
    // Guards the race between the check above and the insert; the UNIQUE
    // constraint on name is the source of truth.
    if (isUniqueViolation(error)) {
      throw conflict("An RTPL status with this name already exists");
    }
    throw error;
  }

  await insertActivity({
    actorUserId: currentUser.id,
    actorEmail: currentUser.email,
    actorRole: currentUser.role,
    regionId: currentUser.regionId,
    eventType: "RTPL_STATUS_CREATED",
    targetType: "rtpl_status",
    targetId: status.id,
    ipAddress: null,
    userAgent: null,
    metadata: {
      name: status.name,
      category: status.category,
      bodEodBucket: status.bodEodBucket,
    },
    status: "SUCCESS",
  });

  invalidateStatusBuckets();
  return status;
}

export interface UpdateRtplStatusServiceInput {
  name?: string;
  category?: string;
  sortOrder?: number;
  bodEodBucket?: unknown;
}

export interface UpdateRtplStatusServiceResult {
  status: RtplStatus;
  /**
   * How many report-row status values were rewritten from the old name to the
   * new one when this update renamed the status. Zero when nothing was renamed.
   */
  renamedRowValues: number;
}

export async function updateRtplStatusService(
  currentUser: AuthenticatedUser,
  id: string,
  input: UpdateRtplStatusServiceInput,
): Promise<UpdateRtplStatusServiceResult> {
  const existing = await findRtplStatusById(id);
  if (!existing) {
    throw notFound("RTPL status not found");
  }

  const updateData: Parameters<typeof updateRtplStatus>[1] = {
    updatedBy: currentUser.id,
  };

  const locked = lockedStatusBucket(existing.name);

  if (input.name !== undefined) {
    const name = normalizeName(input.name);
    if (locked && name !== existing.name) {
      throw badRequest(lockedMessage(existing.name, locked));
    }
    const clash = await findRtplStatusByName(name);
    if (clash && clash.id !== id) {
      throw conflict("An RTPL status with this name already exists");
    }
    updateData.name = name;
  }
  if (input.category !== undefined) updateData.category = normalizeCategory(input.category);
  if (input.sortOrder !== undefined) updateData.sortOrder = input.sortOrder;
  if (input.bodEodBucket !== undefined) {
    const bucket = await normalizeBucket(input.bodEodBucket, existing.bodEodBucket);
    if (locked && bucket !== locked) {
      throw badRequest(lockedMessage(existing.name, locked));
    }
    updateData.bodEodBucket = bucket;
  }
  // Renaming a status INTO a system name pins it to that name's row.
  const lockedByNewName =
    updateData.name !== undefined ? lockedStatusBucket(updateData.name) : null;
  if (lockedByNewName) updateData.bodEodBucket = lockedByNewName;

  let updated: RtplStatus | null;
  try {
    updated = await updateRtplStatus(id, updateData);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("An RTPL status with this name already exists");
    }
    throw error;
  }
  if (!updated) {
    throw notFound("RTPL status not found");
  }

  // A rename cascades to existing report rows so dashboards never split one
  // status across two spellings. Runs after the master rename: the cascade is
  // a case-insensitive old-name -> new-name rewrite, so if it ever failed the
  // admin can re-trigger it by renaming back and forth.
  const isRename =
    updateData.name !== undefined && updateData.name !== existing.name;
  const renamedRowValues = isRename
    ? await renameRtplStatusValueInReportRows(existing.name, updateData.name!)
    : 0;

  await insertActivity({
    actorUserId: currentUser.id,
    actorEmail: currentUser.email,
    actorRole: currentUser.role,
    regionId: currentUser.regionId,
    eventType: "RTPL_STATUS_UPDATED",
    targetType: "rtpl_status",
    targetId: id,
    ipAddress: null,
    userAgent: null,
    metadata: isRename
      ? {
          changes: Object.keys(input),
          renamedFrom: existing.name,
          renamedTo: updateData.name,
          renamedRowValues,
          bodEodBucket: updated.bodEodBucket,
        }
      : updated.bodEodBucket !== existing.bodEodBucket
        ? {
            changes: Object.keys(input),
            bodEodBucketFrom: existing.bodEodBucket,
            bodEodBucketTo: updated.bodEodBucket,
          }
        : { changes: Object.keys(input) },
    status: "SUCCESS",
  });

  invalidateStatusBuckets();
  return { status: updated, renamedRowValues };
}

export async function setRtplStatusActiveService(
  currentUser: AuthenticatedUser,
  id: string,
  isActive: boolean,
): Promise<RtplStatus> {
  const existing = await findRtplStatusById(id);
  if (!existing) {
    throw notFound("RTPL status not found");
  }

  if (existing.isActive === isActive) {
    return existing;
  }

  const locked = lockedStatusBucket(existing.name);
  if (locked && !isActive) {
    throw badRequest(lockedMessage(existing.name, locked));
  }

  const updated = await setRtplStatusActive(id, isActive, currentUser.id);
  if (!updated) {
    throw notFound("RTPL status not found");
  }

  await insertActivity({
    actorUserId: currentUser.id,
    actorEmail: currentUser.email,
    actorRole: currentUser.role,
    regionId: currentUser.regionId,
    eventType: "RTPL_STATUS_UPDATED",
    targetType: "rtpl_status",
    targetId: id,
    ipAddress: null,
    userAgent: null,
    metadata: { isActive },
    status: "SUCCESS",
  });

  return updated;
}

export async function deleteRtplStatusService(
  currentUser: AuthenticatedUser,
  id: string,
): Promise<void> {
  const existing = await findRtplStatusById(id);
  if (!existing) {
    throw notFound("RTPL status not found");
  }

  const locked = lockedStatusBucket(existing.name);
  if (locked) {
    throw badRequest(lockedMessage(existing.name, locked));
  }

  await deleteRtplStatus(id);
  invalidateStatusBuckets();

  await insertActivity({
    actorUserId: currentUser.id,
    actorEmail: currentUser.email,
    actorRole: currentUser.role,
    regionId: currentUser.regionId,
    eventType: "RTPL_STATUS_DELETED",
    targetType: "rtpl_status",
    targetId: id,
    ipAddress: null,
    userAgent: null,
    metadata: { name: existing.name },
    status: "SUCCESS",
  });
}
