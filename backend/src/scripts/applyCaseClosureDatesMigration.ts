import { closeDatabasePool, pool } from "../config/database.js";

// Migration 029_case_closure_dates.sql — imported case closure dates keyed by WO id /
// Case id. Purely additive.
//
// The SQL file also creates a UNIQUE index on case_id; it is left out here on purpose.
// 065 drops that index (one case may carry several work orders), and once it is gone the
// table holds legitimate duplicate case_ids — so re-creating it on every deploy failed,
// and the runner stopped there, leaving every later migration unapplied. 065 adds the
// plain case_id index this table actually uses.
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
