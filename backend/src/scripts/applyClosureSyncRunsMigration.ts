import { closeDatabasePool, pool } from "../config/database.js";

// Migration 042_closure_sync_runs.sql — a run log for closure imports.
//
// The Closed Calls freshness badge used to read MAX(imported_at) from
// case_closure_dates ROWS, so a perfectly healthy auto-sync that imported an
// empty new-day export (0 rows) never moved the timestamp: every morning the
// badge showed "Auto-synced 23:5x · stale" until Flex recorded its first
// closure of the day, and a genuinely dead worker looked exactly the same.
// This table records the RUN itself — even one that imported nothing — so
// "the sync is alive" and "new data arrived" are separate facts.
//
// Purely additive. Safe to re-run.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS closure_sync_runs (
     id         BIGSERIAL PRIMARY KEY,
     source     TEXT        NOT NULL DEFAULT 'MANUAL',
     mode       TEXT        NOT NULL DEFAULT 'replace',
     total_rows INTEGER     NOT NULL DEFAULT 0,
     imported   INTEGER     NOT NULL DEFAULT 0,
     ran_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
  `CREATE INDEX IF NOT EXISTS closure_sync_runs_ran_at_idx
     ON closure_sync_runs (ran_at DESC);`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 042_closure_sync_runs.sql");
  } catch (error) {
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
