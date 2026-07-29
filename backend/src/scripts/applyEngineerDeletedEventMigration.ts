import { closeDatabasePool, pool } from "../config/database.js";

// Migration 039_engineer_deleted_event.sql — activity event type for engineer deletes.
const sqlQueries = [
  `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'ENGINEER_DELETED';`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 039_engineer_deleted_event.sql");
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
