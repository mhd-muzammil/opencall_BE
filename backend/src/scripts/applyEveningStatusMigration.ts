import { closeDatabasePool, pool } from "../config/database.js";

// Migration 021_evening_rtpl_status.sql — Evening (EOD) RTPL status column.
const sqlQueries = [
  `ALTER TABLE daily_call_plan_report_rows ADD COLUMN IF NOT EXISTS evening_rtpl_status TEXT;`,
];

async function run(): Promise<void> {
  const client = await pool.connect();

  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 021_evening_rtpl_status.sql");
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
