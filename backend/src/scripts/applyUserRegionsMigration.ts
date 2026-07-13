import { closeDatabasePool, pool } from "../config/database.js";

// Mirrors infra/postgres/migrations/025_user_regions.sql. Every statement is
// idempotent, so re-running is safe.
const sqlQueries = [
  // A REGION_ADMIN can manage multiple regions. users.region_id stays the primary
  // region; this table holds any additional managed regions.
  `CREATE TABLE IF NOT EXISTS user_regions (
     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     region_id UUID NOT NULL REFERENCES regions(id),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (user_id, region_id)
   );`,

  `CREATE INDEX IF NOT EXISTS idx_user_regions_user ON user_regions(user_id);`,
];

async function run(): Promise<void> {
  const client = await pool.connect();

  try {
    for (const sql of sqlQueries) {
      await client.query(sql);
    }
    console.log("Applied migration 025_user_regions.sql");
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
