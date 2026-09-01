import { closeDatabasePool, pool } from "../config/database.js";

// Migration 066_flex_wip_latest_per_ticket.sql — the index the Payroll sync needs.
// Inlined because the deploy image does not ship the repo's infra/ directory.
//
// The sync's second query asks flex_wip_records for the NEWEST record of each
// ticket, once per report row. idx_flex_wip_ticket covers normalized_ticket_id
// alone, so "newest" cannot come from the index: every historical copy of every
// ticket is heap-fetched and sorted, for all 3,800-odd rows of the day. The table
// is append-only — uploads INSERT without ON CONFLICT and nothing in production
// deletes — so that cost grows daily until it crosses statement_timeout, which is
// what took engineers' case lists away. Nothing else runs this query, which is
// why nothing else was affected and nobody saw it coming.
//
// Plain, not CONCURRENTLY, and in a transaction: 059 is here because a concurrent
// build on this database "waited on the very queries it was meant to speed up and
// never finished". This table is written on every upload, so a concurrent build
// would have the same problem. A plain build takes a brief exclusive lock and
// finishes.
const STATEMENTS = [
  // Whatever a cancelled build may have left behind — an invalid index would be
  // ignored by the planner while still costing writes.
  `DROP INDEX IF EXISTS idx_flex_wip_ticket_created;`,

  `CREATE INDEX idx_flex_wip_ticket_created
     ON flex_wip_records (normalized_ticket_id, created_at DESC)
     INCLUDE (customer_address, common_address, customer_pincode);`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    // The ceiling that is causing the outage would abort the build too.
    await client.query("SET statement_timeout = 0");
    await client.query("SET lock_timeout = '30s'");

    await client.query("BEGIN");
    for (const sql of STATEMENTS) {
      console.log(`  ${sql.trim().split("\n")[0]}`);
      await client.query(sql);
    }
    await client.query("COMMIT");

    // Outside the transaction: a new index carries no statistics until analysed,
    // and it is a planner without them that picks the walk we are replacing.
    console.log("Analysing flex_wip_records...");
    await client.query("ANALYZE flex_wip_records;");

    console.log("Applied migration 066_flex_wip_latest_per_ticket.sql");
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
