import { closeDatabasePool, pool } from "../config/database.js";

// Migration 050_email_replies.sql — Stage 2 replies, approval mode.
// Purely additive: one new table + one column on the 043 mailbox table.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS email_replies (
     id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     inbound_email_id  UUID NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
     to_email          TEXT NOT NULL,
     subject           TEXT NOT NULL DEFAULT '',
     body              TEXT NOT NULL DEFAULT '',
     generated_by      TEXT NOT NULL DEFAULT 'TEMPLATE',
     status            TEXT NOT NULL DEFAULT 'DRAFT',
     approved_by       UUID REFERENCES users(id),
     sent_at           TIMESTAMPTZ,
     error             TEXT NOT NULL DEFAULT '',
     created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS email_replies_inbound_uidx
     ON email_replies (inbound_email_id);`,
  `CREATE INDEX IF NOT EXISTS email_replies_status_idx ON email_replies (status);`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_replies_status_chk') THEN
       ALTER TABLE email_replies ADD CONSTRAINT email_replies_status_chk
         CHECK (status IN ('DRAFT', 'SENT', 'FAILED'));
     END IF;
   END $$;`,
  `ALTER TABLE region_mailboxes
     ADD COLUMN IF NOT EXISTS reply_mode TEXT NOT NULL DEFAULT 'APPROVAL';`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'region_mailboxes_reply_mode_chk') THEN
       ALTER TABLE region_mailboxes ADD CONSTRAINT region_mailboxes_reply_mode_chk
         CHECK (reply_mode IN ('APPROVAL', 'TEMPLATE_AUTO', 'AI_AUTO'));
     END IF;
   END $$;`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 050_email_replies.sql");
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
