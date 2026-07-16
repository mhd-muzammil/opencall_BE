import { closeDatabasePool, pool } from "../config/database.js";

// Migration 028_user_accessible_sections.sql — per-user operational section access for
// REGION_ADMIN logins. Additive; NULL = all sections (previous behaviour).
const sqlQueries = [
  `ALTER TABLE users
     ADD COLUMN IF NOT EXISTS accessible_sections TEXT[];`,
];

async function run(): Promise<void> {
  const client = await pool.connect();

  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 028_user_accessible_sections.sql");
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
