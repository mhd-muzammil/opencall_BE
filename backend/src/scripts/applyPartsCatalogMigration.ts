import { closeDatabasePool, pool } from "../config/database.js";

// Migration 032_parts_catalog.sql — OpenCall-owned HP Stock RMA parts catalog.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS parts_catalog (
     id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     part_number   TEXT NOT NULL DEFAULT '',
     description   TEXT NOT NULL DEFAULT '',
     category      TEXT NOT NULL DEFAULT '',
     price         NUMERIC(12,2) NOT NULL DEFAULT 0,
     hsn_code      TEXT NOT NULL DEFAULT '',
     igst          TEXT NOT NULL DEFAULT '',
     cgst          TEXT NOT NULL DEFAULT '',
     sgst          TEXT NOT NULL DEFAULT '',
     eosl_flag     TEXT NOT NULL DEFAULT '',
     validity      DATE,
     parts_status  TEXT NOT NULL DEFAULT '',
     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
  `CREATE INDEX IF NOT EXISTS parts_catalog_part_number_idx
     ON parts_catalog (part_number);`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 032_parts_catalog.sql");
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
