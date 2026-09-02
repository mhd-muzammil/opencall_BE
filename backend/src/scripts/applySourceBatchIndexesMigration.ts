import { closeDatabasePool, pool } from "../config/database.js";

// Migration 067_source_batch_lookup_indexes.sql — the indexes report generation has
// needed since 001. Inlined because the deploy image does not ship infra/.
//
// All six were created by hand on production on 2026-09-01 to end an outage, and
// existed in no migration: a rebuilt database, a restored backup or a new
// environment would come up without them and reproduce it. See the .sql file for
// the full account.
//
// The one that caused the outage: flex_wip_records is queried ONLY by
// upload_batch_id on every page load, and that column had no index — a foreign key
// is a constraint in Postgres, not an index. At 2.3M rows / 4.6 GB that is a ~16
// minute sequential scan holding a pool connection.
//
// Plain, not CONCURRENTLY, and in a transaction — the same reasoning as 059 and
// 066. A concurrent build here waits on the very queries it exists to eliminate,
// and one run during working hours saturated disk I/O and took the site down.
const STATEMENTS = [
  // DROP first throughout: a cancelled CONCURRENTLY build leaves an INVALID index,
  // which the planner ignores while writes still pay for it — and `IF NOT EXISTS`
  // would happily skip past one. Production has exactly that history.
  `DROP INDEX IF EXISTS idx_flex_wip_batch;`,
  `CREATE INDEX idx_flex_wip_batch
     ON flex_wip_records (upload_batch_id, row_number);`,

  `DROP INDEX IF EXISTS idx_renderways_batch;`,
  `CREATE INDEX idx_renderways_batch
     ON renderways_records (upload_batch_id, row_number);`,

  `DROP INDEX IF EXISTS idx_call_plan_batch;`,
  `CREATE INDEX idx_call_plan_batch
     ON call_plan_records (upload_batch_id, row_number);`,

  `DROP INDEX IF EXISTS idx_rhs_completed_report;`,
  `CREATE INDEX idx_rhs_completed_report
     ON report_history_sessions (daily_call_plan_report_id, created_at DESC)
     WHERE status = 'COMPLETED' AND daily_call_plan_report_id IS NOT NULL;`,

  `DROP INDEX IF EXISTS idx_dcpr_report_date;`,
  `CREATE INDEX idx_dcpr_report_date
     ON daily_call_plan_reports (report_date DESC, created_at DESC);`,

  `DROP INDEX IF EXISTS idx_flex_wip_case_raw;`,
  `CREATE INDEX idx_flex_wip_case_raw
     ON flex_wip_records (case_id);`,
];

const ANALYZED_TABLES = [
  "flex_wip_records",
  "renderways_records",
  "call_plan_records",
  "report_history_sessions",
  "daily_call_plan_reports",
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    // The database-level ceiling would abort these builds on a large table.
    await client.query("SET statement_timeout = 0");
    await client.query("SET lock_timeout = '30s'");

    await client.query("BEGIN");
    for (const sql of STATEMENTS) {
      console.log(`  ${sql.trim().split("\n")[0]}`);
      await client.query(sql);
    }
    await client.query("COMMIT");

    // Outside the transaction: a new index carries no statistics until analysed,
    // and it is a planner without them that keeps choosing the scan.
    for (const table of ANALYZED_TABLES) {
      console.log(`Analysing ${table}...`);
      await client.query(`ANALYZE ${table};`);
    }

    console.log("Applied migration 067_source_batch_lookup_indexes.sql");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* nothing open */
    }
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
