import {
  STATUS_BUCKETS,
  classifyProductivityStatus,
  isActionableStatus,
  setStatusBucketMap,
  statusInBodEodRow,
  suggestStatusBucket,
  type StatusBucket,
} from "@opencall/shared";
import { closeDatabasePool, pool } from "../config/database.js";

// Migration 068_rtpl_status_bucket.sql — the BOD/EOD row each RTPL status counts
// under. Inlined because the deploy image does not ship the repo's infra/ directory.
//
// Fills the new column for statuses that have none yet, but ONLY where the row
// reproduces exactly what the dashboards count today: the same BOD/EOD rows, the
// same Actionable membership and the same Engineer Productivity bucket. Before
// this column, the BOD/EOD table and productivity each guessed from the status
// name with their own keyword lists, and for a few statuses the two disagree
// ("HP Pending" is Under Observation in productivity but in no BOD/EOD row). No
// single row reproduces both, so those are left NULL: they keep the old keyword
// rules, unchanged, until an admin picks a row for them on the RTPL Statuses page.
//
// Only NULLs are touched: a row an admin has chosen is never overwritten, which
// keeps this safe to re-run on every deploy.
//
// Prints each status and what it got, so the prod list can be checked once.

/** The rows that are actual lines in the BOD/EOD table ("Other" is not). */
const TABLE_ROWS = STATUS_BUCKETS.filter((bucket) => bucket !== "OTHER");

function countedAs(name: string): string {
  const rows = TABLE_ROWS.filter((bucket) => statusInBodEodRow(name, bucket));
  return JSON.stringify({
    rows,
    actionable: isActionableStatus(name),
    productivity: classifyProductivityStatus(name),
  });
}

/** Would storing `bucket` for this status change any number on any screen? */
function keepsTodaysNumbers(name: string, bucket: StatusBucket): boolean {
  setStatusBucketMap([]);
  const today = countedAs(name);
  setStatusBucketMap([{ name, bucket }]);
  const mapped = countedAs(name);
  setStatusBucketMap([]);
  return today === mapped;
}

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `ALTER TABLE rtpl_statuses ADD COLUMN IF NOT EXISTS bod_eod_bucket VARCHAR(32);`,
    );

    const pending = await client.query<{ id: string; name: string; is_active: boolean }>(
      `SELECT id, name, is_active FROM rtpl_statuses
       WHERE bod_eod_bucket IS NULL
       ORDER BY sort_order, name`,
    );
    let filled = 0;
    for (const row of pending.rows) {
      const bucket = suggestStatusBucket(row.name);
      const state = row.is_active ? " " : "x";
      if (!keepsTodaysNumbers(row.name, bucket)) {
        console.log(
          `  ${state} ${row.name.padEnd(32)} -> left on the old rules (an admin can choose; suggested ${bucket})`,
        );
        continue;
      }
      await client.query(
        `UPDATE rtpl_statuses SET bod_eod_bucket = $2 WHERE id = $1 AND bod_eod_bucket IS NULL`,
        [row.id, bucket],
      );
      filled += 1;
      console.log(`  ${state} ${row.name.padEnd(32)} -> ${bucket}`);
    }
    await client.query("COMMIT");

    console.log(
      `Applied migration 068_rtpl_status_bucket.sql (${filled} status(es) filled, ` +
        `${pending.rows.length - filled} left on the old rules)`,
    );
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* nothing open */
    }
    console.error("Migration failed:", error);
    throw error;
  } finally {
    client.release();
  }
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabasePool();
  });
