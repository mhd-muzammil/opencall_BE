import { randomBytes } from "node:crypto";
import {
  STATUS_BUCKET_LABELS,
  isCustomRowProductivity,
  isStatusBucket,
  type CustomBodEodRow,
} from "@opencall/shared";
import type { AuthenticatedUser } from "../../types/auth.js";
import { badRequest, conflict, notFound } from "../../utils/httpError.js";
import { insertActivity } from "../../repositories/activityLogRepository.js";
import {
  deleteBodEodCustomRow,
  findBodEodCustomRowById,
  findBodEodCustomRowByLabel,
  insertBodEodCustomRow,
  listBodEodCustomRows,
  listStatusNamesForRow,
  updateBodEodCustomRow,
  type BodEodCustomRowRecord,
} from "../../repositories/bodEodCustomRowRepository.js";
import { invalidateStatusBuckets, toCustomBodEodRows } from "./statusBucketCache.js";

// BOD/EOD rows a Super Admin adds for statuses that fit none of the built-in
// rows. The built-in rows are fixed in code (Planned, Closed and Actionable
// carry their own logic); these sit alongside them.

const MAX_LABEL_LENGTH = 100;

/** Postgres undefined_table: migration 069 has not been applied yet. */
const PG_UNDEFINED_TABLE = "42P01";

/** Postgres unique-violation error code. */
const PG_UNIQUE_VIOLATION = "23505";

function pgCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function normalizeLabel(label: unknown): string {
  const value = typeof label === "string" ? label.trim() : "";
  if (!value) throw badRequest("Row name is required");
  if (value.length > MAX_LABEL_LENGTH) {
    throw badRequest(`Row name must be ${MAX_LABEL_LENGTH} characters or fewer`);
  }
  const builtIn = Object.values(STATUS_BUCKET_LABELS).some(
    (existing) => existing.toLowerCase() === value.toLowerCase(),
  );
  if (builtIn) throw conflict("A built-in BOD/EOD row already has this name");
  return value;
}

function normalizeProductivity(value: unknown): string {
  if (!isCustomRowProductivity(value)) {
    throw badRequest("Choose how this row counts in Engineer Productivity");
  }
  return value;
}

function normalizeAfterRow(value: unknown): string {
  if (!isStatusBucket(value) || value === "OTHER") {
    throw badRequest("Choose which row this one is shown after");
  }
  return value;
}

async function assertLabelFree(label: string, exceptId?: string): Promise<void> {
  const clash = await findBodEodCustomRowByLabel(label);
  if (clash && clash.id !== exceptId) {
    throw conflict("A BOD/EOD row with this name already exists");
  }
}

async function audit(
  currentUser: AuthenticatedUser,
  rowId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  // Row edits change how statuses are counted, so they share the status audit trail.
  await insertActivity({
    actorUserId: currentUser.id,
    actorEmail: currentUser.email,
    actorRole: currentUser.role,
    regionId: currentUser.regionId,
    eventType: "RTPL_STATUS_UPDATED",
    targetType: "bod_eod_row",
    targetId: rowId,
    ipAddress: null,
    userAgent: null,
    metadata,
    status: "SUCCESS",
  });
}

/**
 * Every custom row, hidden ones included. Empty before migration 069, so the
 * status dropdown that carries these never fails because of them.
 */
export async function listBodEodCustomRowsService(): Promise<BodEodCustomRowRecord[]> {
  try {
    return await listBodEodCustomRows();
  } catch (error) {
    if (pgCode(error) === PG_UNDEFINED_TABLE) return [];
    throw error;
  }
}

export async function createBodEodCustomRowService(
  currentUser: AuthenticatedUser,
  input: { label?: unknown; productivityBucket?: unknown; afterRow?: unknown },
): Promise<BodEodCustomRowRecord> {
  const label = normalizeLabel(input.label);
  const productivityBucket = normalizeProductivity(input.productivityBucket);
  const afterRow = normalizeAfterRow(input.afterRow ?? "TO_BE_CANCEL");
  await assertLabelFree(label);

  let row: BodEodCustomRowRecord;
  try {
    row = await insertBodEodCustomRow({
      key: `C_${randomBytes(5).toString("hex")}`,
      label,
      productivityBucket,
      afterRow,
      createdBy: currentUser.id,
    });
  } catch (error) {
    if (pgCode(error) === PG_UNIQUE_VIOLATION) {
      throw conflict("A BOD/EOD row with this name already exists");
    }
    throw error;
  }

  await audit(currentUser, row.id, {
    action: "created",
    label: row.label,
    productivityBucket: row.productivityBucket,
    afterRow: row.afterRow,
  });
  invalidateStatusBuckets();
  return row;
}

export async function updateBodEodCustomRowService(
  currentUser: AuthenticatedUser,
  id: string,
  input: {
    label?: unknown;
    productivityBucket?: unknown;
    afterRow?: unknown;
    sortOrder?: unknown;
    isActive?: unknown;
  },
): Promise<BodEodCustomRowRecord> {
  const existing = await findBodEodCustomRowById(id);
  if (!existing) throw notFound("BOD/EOD row not found");

  const changes: Parameters<typeof updateBodEodCustomRow>[1] = {
    updatedBy: currentUser.id,
  };
  if (input.label !== undefined) {
    changes.label = normalizeLabel(input.label);
    await assertLabelFree(changes.label, id);
  }
  if (input.productivityBucket !== undefined) {
    changes.productivityBucket = normalizeProductivity(input.productivityBucket);
  }
  if (input.afterRow !== undefined) changes.afterRow = normalizeAfterRow(input.afterRow);
  if (input.sortOrder !== undefined) {
    if (typeof input.sortOrder !== "number" || !Number.isFinite(input.sortOrder)) {
      throw badRequest("sortOrder must be a number");
    }
    changes.sortOrder = input.sortOrder;
  }
  if (input.isActive !== undefined) {
    if (typeof input.isActive !== "boolean") throw badRequest("isActive must be true or false");
    changes.isActive = input.isActive;
  }

  let updated: BodEodCustomRowRecord | null;
  try {
    updated = await updateBodEodCustomRow(id, changes);
  } catch (error) {
    if (pgCode(error) === PG_UNIQUE_VIOLATION) {
      throw conflict("A BOD/EOD row with this name already exists");
    }
    throw error;
  }
  if (!updated) throw notFound("BOD/EOD row not found");

  await audit(currentUser, id, {
    action: "updated",
    changes: Object.keys(input),
    from: {
      label: existing.label,
      productivityBucket: existing.productivityBucket,
      afterRow: existing.afterRow,
      isActive: existing.isActive,
    },
  });
  invalidateStatusBuckets();
  return updated;
}

export async function deleteBodEodCustomRowService(
  currentUser: AuthenticatedUser,
  id: string,
): Promise<void> {
  const existing = await findBodEodCustomRowById(id);
  if (!existing) throw notFound("BOD/EOD row not found");

  // Deleting a row that statuses point at would make their calls vanish from
  // the table without anyone noticing. Move them first.
  const statuses = await listStatusNamesForRow(existing.key);
  if (statuses.length > 0) {
    throw conflict(
      `Move these statuses to another row first: ${statuses.join(", ")}`,
      { statuses },
    );
  }

  await deleteBodEodCustomRow(id);
  await audit(currentUser, id, { action: "deleted", label: existing.label });
  invalidateStatusBuckets();
}

/** The custom rows in the shape the dashboards read, sent with the status dropdown. */
export async function getCustomRowsForDashboardsService(): Promise<CustomBodEodRow[]> {
  return toCustomBodEodRows(await listBodEodCustomRowsService());
}
