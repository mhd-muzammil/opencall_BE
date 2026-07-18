import { closeDatabasePool, pool } from "../config/database.js";

// Migration 034_engineer_hp_vendor_ids.sql — add HP ID + Vendor ID to engineers.
const sqlQueries = [
  `ALTER TABLE engineers
     ADD COLUMN IF NOT EXISTS hp_id     VARCHAR NOT NULL DEFAULT '',
     ADD COLUMN IF NOT EXISTS vendor_id VARCHAR NOT NULL DEFAULT '';`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 034_engineer_hp_vendor_ids.sql");
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
