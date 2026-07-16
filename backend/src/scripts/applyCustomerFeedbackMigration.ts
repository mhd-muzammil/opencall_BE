import { closeDatabasePool, pool } from "../config/database.js";

// Migration 030_case_customer_feedback.sql — customer feedback per closed case,
// keyed by WO id / Case id. Purely additive.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS case_customer_feedback (
     id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     wo_id          TEXT NOT NULL DEFAULT '',
     case_id        TEXT NOT NULL DEFAULT '',
     called         BOOLEAN NOT NULL DEFAULT FALSE,
     customer_said  TEXT NOT NULL DEFAULT '',
     updated_by     TEXT NOT NULL DEFAULT '',
     updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS case_customer_feedback_wo_id_uidx
     ON case_customer_feedback (wo_id) WHERE wo_id <> '';`,
  `CREATE UNIQUE INDEX IF NOT EXISTS case_customer_feedback_case_id_uidx
     ON case_customer_feedback (case_id) WHERE case_id <> '';`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 030_case_customer_feedback.sql");
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
