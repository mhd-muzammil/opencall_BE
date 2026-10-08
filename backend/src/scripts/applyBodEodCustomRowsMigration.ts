import { closeDatabasePool, pool } from "../config/database.js";

// Migration 069_bod_eod_custom_rows.sql — BOD/EOD rows a Super Admin adds on the
// RTPL Statuses page. Inlined because the deploy image does not ship the repo's
// infra/ directory. Every statement is guarded, so re-running is a no-op.
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS bod_eod_custom_rows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      row_key VARCHAR(32) NOT NULL UNIQUE,
      label VARCHAR(100) NOT NULL,
      productivity_bucket VARCHAR(32) NOT NULL,
      after_row VARCHAR(32) NOT NULL DEFAULT 'TO_BE_CANCEL',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by UUID REFERENCES users(id),
      updated_by UUID REFERENCES users(id),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bod_eod_custom_rows_label
      ON bod_eod_custom_rows (lower(label));`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    await client.query("COMMIT");
    console.log("Applied migration 069_bod_eod_custom_rows.sql");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* nothing open */
    }
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
