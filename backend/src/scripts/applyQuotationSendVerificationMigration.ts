import { closeDatabasePool, pool } from "../config/database.js";

// Migration 063_quotation_send_verification.sql — when the Sent folder was last asked
// whether a quotation went out. The answer costs an IMAP search, so the sweep takes a few
// at a time and this is what remembers where it got to. See the .sql file. Inlined because
// the deploy image does not ship infra/.
const sqlQueries = [
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS sent_checked_at TIMESTAMPTZ;`,
  `CREATE INDEX IF NOT EXISTS quotations_send_check_idx
     ON quotations (sent_checked_at NULLS FIRST)
     WHERE sent_at IS NULL;`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 063_quotation_send_verification.sql");
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
