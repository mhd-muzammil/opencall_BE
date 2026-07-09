import { closeDatabasePool, pool } from "../config/database.js";

// Migration 022_user_record_layouts.sql — per-user records-grid column layout.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS user_record_layouts (
     user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     ordered_columns JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_by UUID
   );`,
];

async function run(): Promise<void> {
  const client = await pool.connect();

  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 022_user_record_layouts.sql");
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
