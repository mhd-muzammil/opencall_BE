import { closeDatabasePool, pool } from "../config/database.js";

// Migration 052_outbound_emails.sql — Compose: mail sent from a region mailbox.
// Inlined for the same reason as 051: the deploy image has no infra/ directory.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS outbound_emails (
     id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     region_code    TEXT NOT NULL DEFAULT '',
     from_email     TEXT NOT NULL,
     to_emails      TEXT NOT NULL,
     cc_emails      TEXT NOT NULL DEFAULT '',
     subject        TEXT NOT NULL DEFAULT '',
     body_text      TEXT NOT NULL DEFAULT '',
     in_reply_to_id UUID REFERENCES inbound_emails(id) ON DELETE SET NULL,
     status         TEXT NOT NULL DEFAULT 'QUEUED',
     message_id     TEXT NOT NULL DEFAULT '',
     error          TEXT NOT NULL DEFAULT '',
     sent_by        UUID NOT NULL REFERENCES users(id),
     sent_at        TIMESTAMPTZ,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,

  `CREATE INDEX IF NOT EXISTS outbound_emails_created_idx
     ON outbound_emails (created_at DESC);`,

  `CREATE INDEX IF NOT EXISTS outbound_emails_region_idx
     ON outbound_emails (region_code);`,

  `CREATE INDEX IF NOT EXISTS outbound_emails_reply_idx
     ON outbound_emails (in_reply_to_id)
     WHERE in_reply_to_id IS NOT NULL;`,

  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outbound_emails_status_chk') THEN
       ALTER TABLE outbound_emails ADD CONSTRAINT outbound_emails_status_chk
         CHECK (status IN ('QUEUED', 'SENT', 'FAILED'));
     END IF;
   END $$;`,

  `CREATE TABLE IF NOT EXISTS outbound_email_attachments (
     id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     outbound_email_id UUID NOT NULL REFERENCES outbound_emails(id) ON DELETE CASCADE,
     filename          TEXT NOT NULL DEFAULT '',
     mime_type         TEXT NOT NULL DEFAULT 'application/octet-stream',
     size_bytes        INTEGER NOT NULL DEFAULT 0,
     content           BYTEA NOT NULL,
     created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,

  `CREATE INDEX IF NOT EXISTS outbound_email_attachments_email_idx
     ON outbound_email_attachments (outbound_email_id);`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 052_outbound_emails.sql");
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
