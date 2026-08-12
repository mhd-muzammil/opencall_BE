import { closeDatabasePool, pool } from "../config/database.js";

// Migration 048_inbound_email_body.sql — full message body for the reading pane.
// Purely additive: one nullable column on the 043 table.
const sqlQueries = [
  `ALTER TABLE inbound_emails
     ADD COLUMN IF NOT EXISTS body_text TEXT NOT NULL DEFAULT '';`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 048_inbound_email_body.sql");
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
