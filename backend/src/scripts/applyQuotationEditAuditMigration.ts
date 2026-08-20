import { closeDatabasePool, pool } from "../config/database.js";

// Migration 060_quotation_edit_audit.sql — who last edited a quotation and when. Both
// nullable, because an unedited quotation has no such answer and the creator's name is not
// it. See the .sql file. Inlined because the deploy image does not ship infra/.
const sqlQueries = [
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;`,
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS updated_by TEXT;`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 060_quotation_edit_audit.sql");
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
