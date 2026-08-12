import { closeDatabasePool, pool } from "../config/database.js";

// Migration 049_inbound_email_escalation.sql — escalation flag on an inbound email.
// Purely additive: two columns + one partial index on the 043 table.
const sqlQueries = [
  `ALTER TABLE inbound_emails
     ADD COLUMN IF NOT EXISTS escalation_level TEXT NOT NULL DEFAULT 'NONE',
     ADD COLUMN IF NOT EXISTS escalation_reasons TEXT NOT NULL DEFAULT '';`,
  `CREATE INDEX IF NOT EXISTS inbound_emails_escalation_idx
     ON inbound_emails (escalation_level) WHERE escalation_level <> 'NONE';`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 049_inbound_email_escalation.sql");
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
