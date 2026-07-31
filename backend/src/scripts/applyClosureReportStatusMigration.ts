import { closeDatabasePool, pool } from "../config/database.js";

// Migration 041_closure_report_status.sql — widen case_closure_dates from "just the date"
// to the whole Flex closure record, and let closure_date be NULL (a "Closed - Canceled"
// row has no closure date but is still closed).
//
// Additive apart from the DROP NOT NULL. Safe to re-run.
const sqlQueries = [
  `ALTER TABLE case_closure_dates ALTER COLUMN closure_date DROP NOT NULL;`,
  `ALTER TABLE case_closure_dates
     ADD COLUMN IF NOT EXISTS closed_on            DATE,
     ADD COLUMN IF NOT EXISTS closure_status       TEXT NOT NULL DEFAULT '',
     ADD COLUMN IF NOT EXISTS status_remarks       TEXT NOT NULL DEFAULT '',
     ADD COLUMN IF NOT EXISTS failure_code         TEXT NOT NULL DEFAULT '',
     ADD COLUMN IF NOT EXISTS resolution_comments  TEXT NOT NULL DEFAULT '',
     ADD COLUMN IF NOT EXISTS work_location        TEXT NOT NULL DEFAULT '',
     ADD COLUMN IF NOT EXISTS asp_name             TEXT NOT NULL DEFAULT '',
     ADD COLUMN IF NOT EXISTS activity_time        TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS imported_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     ADD COLUMN IF NOT EXISTS import_source        TEXT NOT NULL DEFAULT 'MANUAL';`,
  `UPDATE case_closure_dates SET closed_on = closure_date WHERE closed_on IS NULL;`,
  `CREATE INDEX IF NOT EXISTS case_closure_dates_closed_on_idx
     ON case_closure_dates (closed_on);`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 041_closure_report_status.sql");
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
