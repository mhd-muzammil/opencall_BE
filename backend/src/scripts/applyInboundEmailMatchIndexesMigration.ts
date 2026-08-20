import { closeDatabasePool, pool } from "../config/database.js";

// Migration 057_inbound_email_match_indexes.sql — expression indexes for the two lookups
// the email ingest runs per message. Without them each lookup scans the whole report-row
// history, which is what starved the IMAP socket during a catch-up sweep. See the .sql
// file. Inlined because the deploy image does not ship the repo's infra/ directory.
//
// CONCURRENTLY keeps report writes running while the index builds, at the cost of not being
// allowed inside a transaction — so each statement is issued on its own and a failed build
// leaves an INVALID index behind rather than rolling back. The check afterwards is what
// turns that into a visible failure instead of an index nothing ever uses.
const INDEXES = [
  {
    name: "daily_call_plan_report_rows_ticket_upper_idx",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS daily_call_plan_report_rows_ticket_upper_idx
            ON daily_call_plan_report_rows (UPPER(TRIM(ticket_id)));`,
  },
  {
    name: "daily_call_plan_report_rows_customer_mail_lower_idx",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS daily_call_plan_report_rows_customer_mail_lower_idx
            ON daily_call_plan_report_rows (LOWER(TRIM(customer_mail)));`,
  },
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const index of INDEXES) {
      console.log(`Building ${index.name} (concurrently — this can take a while)...`);
      await client.query(index.sql);

      // A concurrent build that fails part-way still leaves the index in place, marked
      // invalid; IF NOT EXISTS would then skip it for ever on re-runs and the scans would
      // quietly continue. Say so loudly enough that it gets dropped and retried.
      const check = await client.query<{ indisvalid: boolean }>(
        `SELECT i.indisvalid
           FROM pg_class c
           JOIN pg_index i ON i.indexrelid = c.oid
          WHERE c.relname = $1`,
        [index.name],
      );
      const valid = check.rows[0]?.indisvalid;
      if (valid === undefined) {
        throw new Error(`${index.name} was not created`);
      }
      if (!valid) {
        throw new Error(
          `${index.name} exists but is INVALID — drop it and re-run: ` +
            `DROP INDEX CONCURRENTLY ${index.name};`,
        );
      }
      console.log(`  ${index.name} ready`);
    }
    console.log("Applied migration 057_inbound_email_match_indexes.sql");
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
