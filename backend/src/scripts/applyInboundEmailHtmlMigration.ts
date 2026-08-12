import { closeDatabasePool, pool } from "../config/database.js";

// Migration 051_inbound_email_html.sql — original-fidelity rendering.
// The SQL is inlined rather than read from infra/, because the deploy image does not ship
// the repo's migration directory and this has to run there.
const sqlQueries = [
  `ALTER TABLE inbound_emails
     ADD COLUMN IF NOT EXISTS body_html TEXT NOT NULL DEFAULT '';`,

  `ALTER TABLE inbound_emails
     ADD COLUMN IF NOT EXISTS has_attachments BOOLEAN NOT NULL DEFAULT FALSE;`,

  `CREATE TABLE IF NOT EXISTS inbound_email_attachments (
     id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     inbound_email_id  UUID NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
     content_id        TEXT NOT NULL DEFAULT '',
     filename          TEXT NOT NULL DEFAULT '',
     mime_type         TEXT NOT NULL DEFAULT 'application/octet-stream',
     size_bytes        INTEGER NOT NULL DEFAULT 0,
     is_inline         BOOLEAN NOT NULL DEFAULT FALSE,
     content           BYTEA NOT NULL,
     created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,

  `CREATE INDEX IF NOT EXISTS inbound_email_attachments_email_idx
     ON inbound_email_attachments (inbound_email_id);`,

  `CREATE INDEX IF NOT EXISTS inbound_email_attachments_cid_idx
     ON inbound_email_attachments (inbound_email_id, content_id)
     WHERE content_id <> '';`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 051_inbound_email_html.sql");
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
