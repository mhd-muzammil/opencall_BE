import { closeDatabasePool, pool } from "../config/database.js";

// Migration 039_renewal_leads.sql — the AMC / Warranty Renewal Pipeline follow-up state.
// Purely additive: one new table, plus one index on daily_call_plan_report_rows (an index
// only — no column, constraint or row on any existing table is touched). Run
// statement-by-statement (autocommit) to match the other migration scripts.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS renewal_leads (
     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     serial      TEXT NOT NULL,
     status      TEXT NOT NULL DEFAULT 'New',
     owner       TEXT NOT NULL DEFAULT '',
     remarks     TEXT NOT NULL DEFAULT '',
     updated_by  UUID REFERENCES users(id),
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS renewal_leads_serial_uidx
     ON renewal_leads (serial);`,
  `CREATE INDEX IF NOT EXISTS renewal_leads_status_idx
     ON renewal_leads (status);`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'renewal_leads_status_chk'
     ) THEN
       ALTER TABLE renewal_leads
         ADD CONSTRAINT renewal_leads_status_chk
         CHECK (status IN ('New', 'Contacted', 'Quoted', 'Won', 'Lost', 'Not Interested'));
     END IF;
   END $$;`,
  // Index only, on an existing table. Guarded so a deploy where the reports table has not
  // been created yet (fresh DB, migrations mid-flight) does not abort the whole script.
  `DO $$ BEGIN
     IF to_regclass('public.daily_call_plan_report_rows') IS NOT NULL THEN
       CREATE INDEX IF NOT EXISTS daily_call_plan_report_rows_serial_upper_idx
         ON daily_call_plan_report_rows (UPPER(TRIM(product_serial_no)))
         WHERE product_serial_no IS NOT NULL AND TRIM(product_serial_no) <> '';
     END IF;
   END $$;`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 039_renewal_leads.sql");
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
