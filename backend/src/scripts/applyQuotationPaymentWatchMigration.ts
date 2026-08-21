import { closeDatabasePool, pool } from "../config/database.js";

// Migration 062_quotation_payment_watch.sql — what the customer's reply said, and whether a
// machine or a person acted on it. A status inferred by a rule and one set by a human carry
// different confidence, and the evidence is what makes the undo an informed decision. See
// the .sql file. Inlined because the deploy image does not ship infra/.
const sqlQueries = [
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS payment_source TEXT NOT NULL DEFAULT 'MANUAL';`,
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS payment_evidence_email_id UUID;`,
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS reply_seen_at TIMESTAMPTZ;`,
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS payment_signal TEXT NOT NULL DEFAULT 'NONE';`,
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS payment_signal_reasons TEXT NOT NULL DEFAULT '';`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'quotations_payment_source_chk'
     ) THEN
       ALTER TABLE quotations
         ADD CONSTRAINT quotations_payment_source_chk
         CHECK (payment_source IN ('MANUAL', 'AUTO'));
     END IF;
   END $$;`,
  `CREATE INDEX IF NOT EXISTS quotations_awaiting_reply_idx
     ON quotations (sent_at)
     WHERE sent_at IS NOT NULL AND payment_status = 'PENDING';`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 062_quotation_payment_watch.sql");
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
