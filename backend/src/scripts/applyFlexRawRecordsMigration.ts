import { closeDatabasePool, pool } from "../config/database.js";

// Migration 036_flex_raw_records.sql — imported Flex raw export rows, the third
// closed-call source on the Closed Calls region cards. Purely additive.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS flex_raw_records (
     id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     ticket_no      TEXT NOT NULL DEFAULT '',
     case_id        TEXT NOT NULL DEFAULT '',
     work_location  TEXT NOT NULL DEFAULT '',
     call_status    TEXT NOT NULL DEFAULT '',
     status_group   TEXT NOT NULL DEFAULT 'open',
     start_date     DATE,
     imported_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
  `CREATE INDEX IF NOT EXISTS flex_raw_records_location_status_idx
     ON flex_raw_records (work_location, status_group);`,
  `CREATE INDEX IF NOT EXISTS flex_raw_records_ticket_idx
     ON flex_raw_records (ticket_no) WHERE ticket_no <> '';`,
  `CREATE INDEX IF NOT EXISTS flex_raw_records_case_idx
     ON flex_raw_records (case_id) WHERE case_id <> '';`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 036_flex_raw_records.sql");
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
