import { closeDatabasePool, pool } from "../config/database.js";

// Migration 061_quotation_delivery.sql — sending a quotation and what came back: when it
// went, to whom, how many times, and whether the customer paid. All nullable or defaulted,
// because quotations raised before this were never sent from here and must not read as if
// they were. See the .sql file. Inlined because the deploy image does not ship infra/.
const sqlQueries = [
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;`,
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS sent_to TEXT;`,
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS sent_by TEXT;`,
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS send_count INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ;`,
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'PENDING';`,
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;`,
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS paid_by TEXT;`,
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS payment_note TEXT NOT NULL DEFAULT '';`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'quotations_payment_status_chk'
     ) THEN
       ALTER TABLE quotations
         ADD CONSTRAINT quotations_payment_status_chk
         CHECK (payment_status IN ('PENDING', 'PAID', 'DECLINED'));
     END IF;
   END $$;`,
  `CREATE INDEX IF NOT EXISTS quotations_payment_status_idx
     ON quotations (payment_status, sent_at);`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 061_quotation_delivery.sql");
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
