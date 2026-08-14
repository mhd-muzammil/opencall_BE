import { closeDatabasePool, pool } from "../config/database.js";

// Migration 056_flex_raw_closed_on.sql — per-row WO Closed date on the raw
// records, so the Closed Calls date filter can scope the raw-data line to a
// single day like the other two closure sources. See the .sql file.
// Inlined because the deploy image does not ship the repo's infra/ directory.
const sqlQueries = [
  `ALTER TABLE flex_raw_records
     ADD COLUMN IF NOT EXISTS closed_on DATE;`,
  `CREATE INDEX IF NOT EXISTS flex_raw_records_closed_on_idx
     ON flex_raw_records (closed_on);`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 056_flex_raw_closed_on.sql");
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
