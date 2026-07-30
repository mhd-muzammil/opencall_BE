import { closeDatabasePool, pool } from "../config/database.js";

// Migration 040_evening_status_edit_timestamp.sql — when the Evening (EOD)
// status itself was last edited, so the same-day Evening authority stops
// reading an unrelated field edit as a deliberate Evening clear. The backfill
// is inside the same guard as the ADD COLUMN: it must run exactly once, when
// the column appears, or a re-run would stamp rows whose Evening was never
// edited and re-create the very ambiguity this removes.
const sqlQueries = [
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_name = 'daily_call_plan_report_rows'
         AND column_name = 'evening_rtpl_status_updated_at'
     ) THEN
       ALTER TABLE daily_call_plan_report_rows
         ADD COLUMN evening_rtpl_status_updated_at TIMESTAMPTZ;

       UPDATE daily_call_plan_report_rows
       SET evening_rtpl_status_updated_at = updated_at
       WHERE updated_at IS NOT NULL;
     END IF;
   END $$;`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 040_evening_status_edit_timestamp.sql");
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
