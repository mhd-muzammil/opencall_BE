import { closeDatabasePool, pool } from "../config/database.js";

// Migration 071_quotation_kind.sql — Visit and Part quotations side by side: a kind on every
// quotation (existing ones are Part) and the Visit quotation's own QEV number series. See the
// .sql file. Inlined because the deploy image does not ship infra/.
const sqlQueries = [
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'PART';`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'quotations_kind_chk'
     ) THEN
       ALTER TABLE quotations
         ADD CONSTRAINT quotations_kind_chk
         CHECK (kind IN ('PART', 'VISIT'));
     END IF;
   END $$;`,
  `CREATE TABLE IF NOT EXISTS quotation_visit_sequences (
     fin_year   TEXT PRIMARY KEY,
     last_seq   INTEGER NOT NULL DEFAULT 0
   );`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 071_quotation_kind.sql");
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
