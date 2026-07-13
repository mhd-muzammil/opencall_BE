import type {
  WarrantyJobItemCounts,
  WarrantyJobItemState,
  WarrantyLookupStatus,
} from "@opencall/shared";
import { query } from "../config/database.js";

export interface WarrantyJobItemRow {
  id: string;
  job_id: string;
  serial: string;
  product_number: string | null;
  state: WarrantyJobItemState;
  lookup_status: WarrantyLookupStatus | null;
  end_date: string | null;
  hp_status: string | null;
  attempts: number;
  last_error: string | null;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WarrantyJobItem {
  id: string;
  jobId: string;
  /** Empty string is the blank-serial bucket (rows with no serial at all). */
  serial: string;
  /** Column K with the `#...` localization suffix stripped. */
  productNumber: string | null;
  state: WarrantyJobItemState;
  lookupStatus: WarrantyLookupStatus | null;
  /** ISO `YYYY-MM-DD`. */
  endDate: string | null;
  hpStatus: string | null;
  attempts: number;
  lastError: string | null;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const WARRANTY_JOB_ITEM_COLUMNS = `
  id,
  job_id,
  serial,
  product_number,
  state,
  lookup_status,
  end_date::TEXT AS end_date,
  hp_status,
  attempts,
  last_error,
  locked_at::TEXT AS locked_at,
  created_at::TEXT AS created_at,
  updated_at::TEXT AS updated_at
`;

function mapWarrantyJobItem(row: WarrantyJobItemRow): WarrantyJobItem {
  return {
    id: row.id,
    jobId: row.job_id,
    serial: row.serial,
    productNumber: row.product_number,
    state: row.state,
    lookupStatus: row.lookup_status,
    endDate: row.end_date,
    hpStatus: row.hp_status,
    attempts: Number(row.attempts),
    lastError: row.last_error,
    lockedAt: row.locked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InsertWarrantyJobItemInput {
  jobId: string;
  serial: string;
  productNumber: string | null;
  state: WarrantyJobItemState;
  lookupStatus: WarrantyLookupStatus | null;
  endDate: string | null;
  hpStatus: string | null;
}

const ITEM_INSERT_COLUMN_COUNT = 7;

export async function insertWarrantyJobItems(
  items: readonly InsertWarrantyJobItemInput[],
): Promise<number> {
  if (items.length === 0) {
    return 0;
  }

  const params: unknown[] = [];
  const tuples = items.map((item, index) => {
    const offset = index * ITEM_INSERT_COLUMN_COUNT;
    params.push(
      item.jobId,
      item.serial,
      item.productNumber,
      item.state,
      item.lookupStatus,
      item.endDate,
      item.hpStatus,
    );
    const placeholders = Array.from(
      { length: ITEM_INSERT_COLUMN_COUNT },
      (_value, column) => `$${offset + column + 1}`,
    );
    return `(${placeholders.join(", ")})`;
  });

  const result = await query(
    `
      INSERT INTO warranty_job_items (
        job_id, serial, product_number, state, lookup_status, end_date, hp_status
      )
      VALUES ${tuples.join(", ")}
      ON CONFLICT (job_id, serial) DO NOTHING
    `,
    params,
  );

  return result.rowCount ?? 0;
}

/**
 * Atomically claim the oldest pending item. `FOR UPDATE SKIP LOCKED` lets several
 * worker processes drain the queue concurrently without ever handing the same
 * row to two of them.
 */
export async function claimNextPendingItem(): Promise<WarrantyJobItem | null> {
  const result = await query<WarrantyJobItemRow>(
    `
      UPDATE warranty_job_items
         SET state = 'processing',
             locked_at = NOW(),
             attempts = attempts + 1,
             updated_at = NOW()
       WHERE id = (
         SELECT id
           FROM warranty_job_items
          WHERE state = 'pending'
          ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
      RETURNING ${WARRANTY_JOB_ITEM_COLUMNS}
    `,
  );

  const row = result.rows[0];
  return row ? mapWarrantyJobItem(row) : null;
}

export interface MarkItemDoneInput {
  lookupStatus: WarrantyLookupStatus;
  endDate: string | null;
  hpStatus: string | null;
}

export async function markItemDone(
  id: string,
  input: MarkItemDoneInput,
): Promise<WarrantyJobItem | null> {
  const result = await query<WarrantyJobItemRow>(
    `
      UPDATE warranty_job_items
         SET state = 'done',
             lookup_status = $2,
             end_date = $3,
             hp_status = $4,
             last_error = NULL,
             locked_at = NULL,
             updated_at = NOW()
       WHERE id = $1
      RETURNING ${WARRANTY_JOB_ITEM_COLUMNS}
    `,
    [id, input.lookupStatus, input.endDate, input.hpStatus],
  );

  const row = result.rows[0];
  return row ? mapWarrantyJobItem(row) : null;
}

export async function markItemFailed(
  id: string,
  lastError: string,
): Promise<WarrantyJobItem | null> {
  const result = await query<WarrantyJobItemRow>(
    `
      UPDATE warranty_job_items
         SET state = 'failed',
             lookup_status = 'FAILED',
             locked_at = NULL,
             last_error = $2,
             updated_at = NOW()
       WHERE id = $1
      RETURNING ${WARRANTY_JOB_ITEM_COLUMNS}
    `,
    [id, lastError],
  );

  const row = result.rows[0];
  return row ? mapWarrantyJobItem(row) : null;
}

interface WarrantyJobItemCountsRow {
  total: string;
  pending: string;
  processing: string;
  done: string;
  failed: string;
  ok: string;
  not_found: string;
  no_serial: string;
  failed_lookup: string;
}

export async function countJobItems(
  jobId: string,
): Promise<WarrantyJobItemCounts> {
  const result = await query<WarrantyJobItemCountsRow>(
    `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE state = 'pending') AS pending,
        COUNT(*) FILTER (WHERE state = 'processing') AS processing,
        COUNT(*) FILTER (WHERE state = 'done') AS done,
        COUNT(*) FILTER (WHERE state = 'failed') AS failed,
        COUNT(*) FILTER (WHERE lookup_status = 'OK') AS ok,
        COUNT(*) FILTER (WHERE lookup_status = 'NOT_FOUND') AS not_found,
        COUNT(*) FILTER (WHERE lookup_status = 'NO_SERIAL') AS no_serial,
        COUNT(*) FILTER (WHERE lookup_status = 'FAILED') AS failed_lookup
      FROM warranty_job_items
      WHERE job_id = $1
    `,
    [jobId],
  );

  const row = result.rows[0];

  return {
    total: Number(row?.total ?? 0),
    pending: Number(row?.pending ?? 0),
    processing: Number(row?.processing ?? 0),
    done: Number(row?.done ?? 0),
    failed: Number(row?.failed ?? 0),
    ok: Number(row?.ok ?? 0),
    notFound: Number(row?.not_found ?? 0),
    noSerial: Number(row?.no_serial ?? 0),
    failedLookup: Number(row?.failed_lookup ?? 0),
  };
}

export async function listJobItems(jobId: string): Promise<WarrantyJobItem[]> {
  const result = await query<WarrantyJobItemRow>(
    `
      SELECT ${WARRANTY_JOB_ITEM_COLUMNS}
      FROM warranty_job_items
      WHERE job_id = $1
      ORDER BY created_at ASC
    `,
    [jobId],
  );

  return result.rows.map(mapWarrantyJobItem);
}

export interface ReclaimStaleItemsResult {
  requeued: number;
  exhausted: number;
}

/**
 * Recovers items abandoned in `processing` by a worker that died mid-item (crash,
 * OOM, SIGKILL, container eviction).
 *
 * Without this they are stranded forever: `claimNextPendingItem` only takes
 * `pending`, and `resetFailedItems` only takes `failed` — so the item is never
 * retried and, because a job is only complete once nothing is pending *or*
 * processing, the whole job never completes and its file never becomes
 * downloadable.
 *
 * An item that has already burned `maxAttempts` claims is failed rather than
 * requeued, so one poison serial that reliably kills the browser cannot spin the
 * worker forever.
 *
 * @param jobId  Limit to one job (used by the Retry action); null = all jobs.
 */
export async function reclaimStaleProcessingItems(
  staleAfterSeconds: number,
  maxAttempts: number,
  jobId: string | null = null,
): Promise<ReclaimStaleItemsResult> {
  const jobFilter = jobId ? `AND job_id = $3` : "";
  const params: unknown[] = [staleAfterSeconds, maxAttempts];
  if (jobId) {
    params.push(jobId);
  }

  const exhausted = await query(
    `
      UPDATE warranty_job_items
         SET state = 'failed',
             lookup_status = 'FAILED',
             locked_at = NULL,
             last_error = 'Worker died while processing this serial (stale lock); attempt limit reached',
             updated_at = NOW()
       WHERE state = 'processing'
         AND locked_at IS NOT NULL
         AND locked_at < NOW() - ($1 * INTERVAL '1 second')
         AND attempts >= $2
         ${jobFilter}
    `,
    params,
  );

  const requeued = await query(
    `
      UPDATE warranty_job_items
         SET state = 'pending',
             lookup_status = NULL,
             locked_at = NULL,
             last_error = 'Worker died while processing this serial (stale lock); requeued',
             updated_at = NOW()
       WHERE state = 'processing'
         AND locked_at IS NOT NULL
         AND locked_at < NOW() - ($1 * INTERVAL '1 second')
         AND attempts < $2
         ${jobFilter}
    `,
    params,
  );

  return {
    requeued: requeued.rowCount ?? 0,
    exhausted: exhausted.rowCount ?? 0,
  };
}

/** Requeue this job's failed items so the worker picks them up again. */
export async function resetFailedItems(jobId: string): Promise<number> {
  const result = await query(
    `
      UPDATE warranty_job_items
         SET state = 'pending',
             lookup_status = NULL,
             locked_at = NULL,
             updated_at = NOW()
       WHERE job_id = $1
         AND state = 'failed'
    `,
    [jobId],
  );

  return result.rowCount ?? 0;
}
