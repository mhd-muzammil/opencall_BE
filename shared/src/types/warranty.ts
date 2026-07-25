/**
 * Shared types for the HP warranty auto-lookup feature.
 *
 * These are consumed by the Express API (`@opencall/api`) and the Next.js
 * frontend so that both sides agree on the shape of a warranty job, its items,
 * and the per-serial lookup outcome. Kept intentionally framework-free.
 */

/**
 * Business outcome of a single serial lookup. This is what ends up in column
 * `AY` (`_Lookup Status`) of the generated workbook.
 *
 * - `OK`         HP returned a warranty end date.
 * - `NOT_FOUND`  HP resolved the serial but reported no warranty entitlement.
 * - `NO_SERIAL`  The cell was blank or a junk `NOSN` placeholder; never sent to HP.
 * - `FAILED`     The lookup errored (network, timeout, interactive challenge, etc.).
 */
export type WarrantyLookupStatus = "OK" | "NOT_FOUND" | "NO_SERIAL" | "FAILED";

/**
 * Per-closed-call warranty status shown in the Closed Calls "Warranty Lookup" list.
 * Derived from the permanent hp_warranty_cache + the live lookup queue:
 * - IN_WARRANTY / OUT_OF_WARRANTY  cache hit (OK), by end date vs today
 * - NOT_FOUND                       cache hit (HP has no entitlement for this serial)
 * - CHECKING                        enqueued, worker not done yet
 * - NO_SERIAL                       blank / NOSN serial — never sent to HP
 * - NOT_CHECKED                     not cached and not (yet) queued
 */
export type ClosedCallWarrantyStatus =
  | "IN_WARRANTY"
  | "OUT_OF_WARRANTY"
  | "NOT_FOUND"
  | "CHECKING"
  | "NO_SERIAL"
  | "NOT_CHECKED";

export interface ClosedCallWarrantyEntry {
  /** The serial exactly as sent by the caller (so the client can join back). */
  serial: string;
  status: ClosedCallWarrantyStatus;
  /** ISO `YYYY-MM-DD` warranty end date, or null. */
  endDate: string | null;
  /** HP's raw status text (Active / Expired), or null. */
  hpStatus: string | null;
}

export interface ClosedCallWarrantyResponse {
  entries: ClosedCallWarrantyEntry[];
  /** Uncached serials newly enqueued for HP lookup by this request. */
  enqueued: number;
  /** Remaining daily lookup budget after this request (of the ~100/day cap). */
  dailyRemaining: number;
  /** False when the warranty tables are not present (feature not migrated). */
  available: boolean;
}

/** One closed call + its resolved warranty status, for the self-contained list. */
export interface ClosedCallWarrantyListRow {
  ticketId: string;
  customer: string;
  serial: string;
  region: string;
  model: string;
  status: ClosedCallWarrantyStatus;
  /** ISO `YYYY-MM-DD` warranty start date (when coverage began), or null. */
  startDate: string | null;
  endDate: string | null;
  hpStatus: string | null;
}

export interface ClosedCallWarrantyListResponse {
  rows: ClosedCallWarrantyListRow[];
  /** Uncached serials newly enqueued for HP lookup by this request. */
  enqueued: number;
  /** Remaining daily lookup budget after this request (of the ~100/day cap). */
  dailyRemaining: number;
  /** False when the warranty tables are not present (feature not migrated). */
  available: boolean;
}

/**
 * Queue state of a `warranty_job_items` row. Distinct from the business
 * outcome above: an item can be `done` with a lookup status of `NOT_FOUND`.
 */
export type WarrantyJobItemState =
  | "pending"
  | "processing"
  | "done"
  | "failed";

/** Derived roll-up status for a whole job, computed from its item states. */
export type WarrantyJobStatus = "pending" | "processing" | "completed";

export interface WarrantyJob {
  id: string;
  originalFileName: string;
  status: WarrantyJobStatus;
  /** Total data rows in the uploaded Flex WIP sheet. */
  totalRows: number;
  /** Distinct serial candidates enqueued for this job (incl. NO_SERIAL bucket). */
  uniqueSerials: number;
  createdBy: string | null;
  regionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Aggregate counts used to render job progress on the frontend. */
export interface WarrantyJobItemCounts {
  total: number;
  pending: number;
  processing: number;
  done: number;
  failed: number;
  /** Lookup-outcome breakdown (only meaningful for terminal items). */
  ok: number;
  notFound: number;
  noSerial: number;
  failedLookup: number;
}

export interface WarrantyJobDetail extends WarrantyJob {
  counts: WarrantyJobItemCounts;
}
