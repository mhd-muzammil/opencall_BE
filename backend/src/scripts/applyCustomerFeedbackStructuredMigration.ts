import { closeDatabasePool, pool } from "../config/database.js";

// Migration 031 — restructure customer feedback into uniform dropdown values
// (call_status + feedback + remarks), replacing the old called/customer_said shape.
const sqlQueries = [
  `ALTER TABLE case_customer_feedback
     ADD COLUMN IF NOT EXISTS call_status TEXT NOT NULL DEFAULT '',
     ADD COLUMN IF NOT EXISTS feedback    TEXT NOT NULL DEFAULT '',
     ADD COLUMN IF NOT EXISTS remarks     TEXT NOT NULL DEFAULT '';`,
  `DO $$
   BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'case_customer_feedback' AND column_name = 'called') THEN
       UPDATE case_customer_feedback
          SET call_status = CASE WHEN called THEN 'Called' ELSE 'Not Reachable' END
        WHERE call_status = '';
     END IF;
     IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'case_customer_feedback' AND column_name = 'customer_said') THEN
       UPDATE case_customer_feedback
          SET remarks = customer_said
        WHERE remarks = '' AND customer_said <> '';
     END IF;
   END
   $$;`,
  `ALTER TABLE case_customer_feedback DROP COLUMN IF EXISTS called;`,
  `ALTER TABLE case_customer_feedback DROP COLUMN IF EXISTS customer_said;`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 031_customer_feedback_structured.sql");
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
