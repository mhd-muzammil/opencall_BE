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
