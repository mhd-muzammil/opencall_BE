import { closeDatabasePool, pool } from "../config/database.js";

// Migration 037_flex_raw_month.sql — adds source_month to flex_raw_records for the
// month-wise Closed Calls region-card counts. Purely additive.
const sqlQueries = [
  `ALTER TABLE flex_raw_records
     ADD COLUMN IF NOT EXISTS source_month TEXT NOT NULL DEFAULT '';`,
  `CREATE INDEX IF NOT EXISTS flex_raw_records_location_month_status_idx
     ON flex_raw_records (work_location, source_month, status_group);`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 037_flex_raw_month.sql");
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
