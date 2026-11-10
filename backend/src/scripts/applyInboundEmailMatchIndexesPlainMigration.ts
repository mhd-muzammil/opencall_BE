import { closeDatabasePool, pool } from "../config/database.js";

// Migration 059_inbound_email_match_indexes_plain.sql — the 058 composites, built plainly.
// The concurrent build waited on the very queries it was meant to speed up and never
// finished; on a 138k-row table an ordinary build costs seconds. See the .sql file.
// Inlined because the deploy image does not ship the repo's infra/ directory.
//
// Wrapped in a transaction, unlike 057/058: without CONCURRENTLY there is nothing stopping
// it, and it means a failure part-way cannot leave the table with one new index and one old
// one dropped.
const STATEMENTS = [
  // Whatever a cancelled concurrent build left behind, valid or not. No IF NOT EXISTS on
  // the creates below, so a leftover invalid index cannot be silently kept.
  `DROP INDEX IF EXISTS daily_call_plan_report_rows_ticket_upper_id_idx;`,
  `DROP INDEX IF EXISTS daily_call_plan_report_rows_cust_mail_lower_id_idx;`,

  `CREATE INDEX daily_call_plan_report_rows_ticket_upper_id_idx
     ON daily_call_plan_report_rows (UPPER(TRIM(ticket_id)), id DESC);`,
  `CREATE INDEX daily_call_plan_report_rows_cust_mail_lower_id_idx
     ON daily_call_plan_report_rows (LOWER(TRIM(customer_mail)), id DESC);`,

  // Superseded: a composite on (expr, id) serves every query the expr-only index served.
  `DROP INDEX IF EXISTS daily_call_plan_report_rows_ticket_upper_idx;`,
  `DROP INDEX IF EXISTS daily_call_plan_report_rows_customer_mail_lower_idx;`,
];

// Applied already: both composites present and valid, both superseded indexes gone. Without
// this check every deploy re-ran the drop-and-rebuild, and on production's 30M-row table that
// holds an ACCESS EXCLUSIVE lock for minutes -- the live app's queries on the table queued
// behind it (deploy of 2026-11-10).
const APPLIED_CHECK = `
  SELECT
    (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname IN ('daily_call_plan_report_rows_ticket_upper_id_idx',
                          'daily_call_plan_report_rows_cust_mail_lower_id_idx')
        AND i.indisvalid) = 2
    AND
    (SELECT count(*) FROM pg_class
      WHERE relname IN ('daily_call_plan_report_rows_ticket_upper_idx',
                        'daily_call_plan_report_rows_customer_mail_lower_idx')) = 0
    AS applied`;

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ applied: boolean }>(APPLIED_CHECK);
    if (rows[0]?.applied) {
      console.log("Skipped migration 059_inbound_email_match_indexes_plain.sql — already applied");
      return;
    }

    // A statement_timeout inherited from the environment would abort the build mid-way; this
    // is a migration run by hand and is meant to finish.
    await client.query("SET statement_timeout = 0");
    await client.query("SET lock_timeout = '30s'");

    await client.query("BEGIN");
    for (const sql of STATEMENTS) {
      console.log(`  ${sql.trim().split("\n")[0]}`);
      await client.query(sql);
    }
    await client.query("COMMIT");

    // Outside the transaction: an expression index carries no statistics until analysed, and
    // a planner without them is what chose the backward table walk to begin with.
    console.log("Analysing daily_call_plan_report_rows...");
    await client.query("ANALYZE daily_call_plan_report_rows;");

    console.log("Applied migration 059_inbound_email_match_indexes_plain.sql");
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
