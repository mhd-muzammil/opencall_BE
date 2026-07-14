import { closeDatabasePool, pool } from "../config/database.js";

// Migrations that enable Record Format + row editing for special-access logins.
// Both are purely additive (new table / new nullable column).
const sqlQueries = [
  // 026 — per-credential records-grid column layout.
  `CREATE TABLE IF NOT EXISTS special_access_record_layouts (
     special_access_id UUID PRIMARY KEY REFERENCES special_access(id) ON DELETE CASCADE,
     ordered_columns   JSONB NOT NULL,
     updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
  // 027 — attribution for a report-row edit made by a special-access login
  // (`updated_by` is a FK to users(id), which a credential can never satisfy).
  `ALTER TABLE daily_call_plan_report_rows
     ADD COLUMN IF NOT EXISTS updated_by_special_access UUID REFERENCES special_access(id);`,
];

async function run(): Promise<void> {
  const client = await pool.connect();

  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migrations 026 + 027 (special-access layouts + row editing)");
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
