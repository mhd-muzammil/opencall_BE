import { closeDatabasePool, pool } from "../config/database.js";

// Migration 058_inbound_email_match_indexes_ordered.sql — the 057 indexes again, this time
// carrying `id` so the lookups' ORDER BY id DESC LIMIT 1 is served by the index instead of
// tempting the planner into walking the primary key backwards over the whole table. See the
// .sql file. Inlined because the deploy image does not ship the repo's infra/ directory.
//
// CONCURRENTLY throughout, since reports write to this table on a live box — which is also
// why none of this can run inside a transaction, and why a failed build leaves an INVALID
// index rather than rolling back. The check after each create is what makes that visible.
const CREATE = [
  {
    name: "daily_call_plan_report_rows_ticket_upper_id_idx",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS daily_call_plan_report_rows_ticket_upper_id_idx
            ON daily_call_plan_report_rows (UPPER(TRIM(ticket_id)), id DESC);`,
  },
  {
    name: "daily_call_plan_report_rows_cust_mail_lower_id_idx",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS daily_call_plan_report_rows_cust_mail_lower_id_idx
            ON daily_call_plan_report_rows (LOWER(TRIM(customer_mail)), id DESC);`,
  },
];

// Only once the replacements are in place and valid. A composite on (expr, id) answers
// everything the expression-only index answered, so these are redundant from that moment.
const DROP = [
  "DROP INDEX CONCURRENTLY IF EXISTS daily_call_plan_report_rows_ticket_upper_idx;",
  "DROP INDEX CONCURRENTLY IF EXISTS daily_call_plan_report_rows_customer_mail_lower_idx;",
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const index of CREATE) {
      console.log(`Building ${index.name} (concurrently — this can take a while)...`);
      await client.query(index.sql);

      const check = await client.query<{ indisvalid: boolean }>(
        `SELECT i.indisvalid
           FROM pg_class c
           JOIN pg_index i ON i.indexrelid = c.oid
          WHERE c.relname = $1`,
        [index.name],
      );
      const valid = check.rows[0]?.indisvalid;
      if (valid === undefined) throw new Error(`${index.name} was not created`);
      if (!valid) {
        throw new Error(
          `${index.name} exists but is INVALID — drop it and re-run: ` +
            `DROP INDEX CONCURRENTLY ${index.name};`,
        );
      }
      console.log(`  ${index.name} ready`);
    }

    for (const sql of DROP) {
      console.log(`Dropping superseded index...`);
      await client.query(sql);
    }

    // An expression index carries no statistics until it is analysed, and it was a planner
    // working without them that chose the backward table walk in the first place.
    console.log("Analysing daily_call_plan_report_rows...");
    await client.query("ANALYZE daily_call_plan_report_rows;");

    console.log("Applied migration 058_inbound_email_match_indexes_ordered.sql");
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
