import { closeDatabasePool, pool } from "../config/database.js";

// Migration 064_fieldez_sla.sql — what FieldEZ promised about each open call, kept between
// refreshes so the screens read it from here rather than opening nine hundred ticket pages.
// See the .sql file for why the DEADLINE is stored and the countdown is not. Inlined because
// the deploy image does not ship infra/.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS fieldez_sla (
     ticket_key         TEXT PRIMARY KEY,
     ticket_no          TEXT NOT NULL,
     case_id            TEXT NOT NULL DEFAULT '',
     fieldez_ticket_id  BIGINT,
     bp_id              INTEGER,
     sla_status         TEXT NOT NULL DEFAULT '',
     sla_policy         TEXT NOT NULL DEFAULT '',
     sla_end_time       TIMESTAMPTZ,
     priority           TEXT NOT NULL DEFAULT '',
     task_name          TEXT NOT NULL DEFAULT '',
     fetched_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
  `CREATE INDEX IF NOT EXISTS fieldez_sla_end_time_idx
     ON fieldez_sla (sla_end_time)
     WHERE sla_end_time IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS fieldez_sla_fetched_idx ON fieldez_sla (fetched_at);`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 064_fieldez_sla.sql");
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
