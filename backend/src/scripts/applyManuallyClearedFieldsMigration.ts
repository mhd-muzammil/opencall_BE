import { closeDatabasePool, pool } from "../config/database.js";

// Migration 046_manually_cleared_fields.sql — which manual fields a user
// deliberately cleared on a report row, so regeneration stops reading a blank
// as "never filled in" and re-carrying the previous report's value over it (the
// "I set the engineer back to Entry and the disabled engineer comes straight
// back on refresh" bug). Same shape as 040 did for the Evening status.
//
// No backfill: a pre-existing blank cannot be told apart from a deliberate
// clear, so every existing row starts with an empty list and behaves as before.
const sqlQueries = [
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_name = 'daily_call_plan_report_rows'
         AND column_name = 'manually_cleared_fields'
     ) THEN
       ALTER TABLE daily_call_plan_report_rows
         ADD COLUMN manually_cleared_fields JSONB NOT NULL DEFAULT '[]'::jsonb;
     END IF;
   END $$;`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 046_manually_cleared_fields.sql");
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
