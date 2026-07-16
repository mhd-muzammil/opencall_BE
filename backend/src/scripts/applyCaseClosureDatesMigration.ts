import { closeDatabasePool, pool } from "../config/database.js";

// Migration 029_case_closure_dates.sql — imported case closure dates keyed by WO id /
// Case id. Purely additive.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS case_closure_dates (
     id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     wo_id         TEXT NOT NULL DEFAULT '',
     case_id       TEXT NOT NULL DEFAULT '',
     closure_date  DATE NOT NULL,
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS case_closure_dates_wo_id_uidx
     ON case_closure_dates (wo_id) WHERE wo_id <> '';`,
  `CREATE UNIQUE INDEX IF NOT EXISTS case_closure_dates_case_id_uidx
     ON case_closure_dates (case_id) WHERE case_id <> '';`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 029_case_closure_dates.sql");
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
