import { closeDatabasePool, pool } from "../config/database.js";

// Mirrors infra/postgres/migrations/034_region_eod.sql. Every statement is
// idempotent, so re-running is safe.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS region_eod_state (
     id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     region_id    UUID NOT NULL REFERENCES regions(id),
     working_date DATE NOT NULL,
     status       TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
     closed_at    TIMESTAMPTZ,
     closed_by    UUID REFERENCES users(id),
     created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (region_id, working_date)
   );`,

  `CREATE INDEX IF NOT EXISTS idx_region_eod_state_date
     ON region_eod_state (working_date);`,

  `CREATE TABLE IF NOT EXISTS region_productivity_snapshot (
     id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     region_id    UUID NOT NULL REFERENCES regions(id),
     working_date DATE NOT NULL,
     payload      JSONB NOT NULL,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (region_id, working_date)
   );`,

  `CREATE INDEX IF NOT EXISTS idx_region_productivity_snapshot_date
     ON region_productivity_snapshot (working_date);`,
];

async function run(): Promise<void> {
  const client = await pool.connect();

  try {
    for (const sql of sqlQueries) {
      await client.query(sql);
    }
    console.log("Applied migration 034_region_eod.sql");
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
