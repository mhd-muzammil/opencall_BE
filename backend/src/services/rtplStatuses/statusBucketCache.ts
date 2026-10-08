import {
  isCustomRowProductivity,
  isStatusBucket,
  setCustomBodEodRows,
  setStatusBucketMap,
  type CustomBodEodRow,
} from "@opencall/shared";
import { listRtplStatusBuckets } from "../../repositories/rtplStatusRepository.js";
import {
  listBodEodCustomRows,
  type BodEodCustomRowRecord,
} from "../../repositories/bodEodCustomRowRepository.js";

// The backend's copy of the admin's status -> BOD/EOD row choices, loaded into
// the shared classifier before anything computes productivity (live views, the
// Engineer Target page, the Final-EOD freeze), so the backend counts a status
// under the same row the dashboards do.
//
// Re-read at most once a minute, and straight after an admin edit on this
// process. Workers and other API instances pick an edit up within the minute.

const MAX_AGE_MS = 60_000;

let loadedAt = 0;
let inflight: Promise<void> | null = null;

/** Postgres undefined_column: migration 068 has not been applied yet. */
const PG_UNDEFINED_COLUMN = "42703";
/** Postgres undefined_table: migration 069 has not been applied yet. */
const PG_UNDEFINED_TABLE = "42P01";

/** The shared shape of a custom row; rows with unusable values are dropped. */
export function toCustomBodEodRows(records: readonly BodEodCustomRowRecord[]): CustomBodEodRow[] {
  return records.flatMap((record) =>
    isCustomRowProductivity(record.productivityBucket) && isStatusBucket(record.afterRow)
      ? [
          {
            key: record.key,
            label: record.label,
            productivityBucket: record.productivityBucket,
            afterRow: record.afterRow,
            sortOrder: record.sortOrder,
            isActive: record.isActive,
          },
        ]
      : [],
  );
}

async function loadCustomRows(): Promise<void> {
  try {
    setCustomBodEodRows(toCustomBodEodRows(await listBodEodCustomRows()));
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== PG_UNDEFINED_TABLE) throw error;
    console.warn("[statusBuckets] bod_eod_custom_rows is missing: run migration 069.");
  }
}

async function load(): Promise<void> {
  try {
    // Rows first: a status pointing at a custom row needs it for productivity.
    await loadCustomRows();
    setStatusBucketMap(await listRtplStatusBuckets());
  } catch (error) {
    // Keep counting with whatever was loaded before (or the keyword fallback):
    // a missing mapping must never take productivity down with it.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === PG_UNDEFINED_COLUMN) {
      console.warn(
        "[statusBuckets] rtpl_statuses.bod_eod_bucket is missing — run migration 068. Using keyword rules.",
      );
    } else {
      console.error("[statusBuckets] could not load the status mapping:", error);
    }
  }
  loadedAt = Date.now();
}

export async function ensureStatusBucketsLoaded(): Promise<void> {
  if (Date.now() - loadedAt < MAX_AGE_MS) return;
  if (!inflight) {
    inflight = load().finally(() => {
      inflight = null;
    });
  }
  await inflight;
}

/** Called after an admin edit, so this process uses the new row immediately. */
export function invalidateStatusBuckets(): void {
  loadedAt = 0;
}
