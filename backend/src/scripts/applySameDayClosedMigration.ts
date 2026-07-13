import { closeDatabasePool, pool } from "../config/database.js";

// Mirrors infra/postgres/migrations/024_same_day_closed_calls.sql. Every statement is
// idempotent, so re-running is safe.
const sqlQueries = [
  // Marks a call that closed on a same-day re-upload: closed everywhere, but still
  // listed on the Records page until the next day's first upload. Persisted because a
  // later re-upload on the same day has to tell a row closed by upload #1 (already off
  // the Records page) apart from one closed by upload #2 (still on it) — and both look
  // identical on change_type alone.
  `ALTER TABLE daily_call_plan_report_rows
     ADD COLUMN IF NOT EXISTS same_day_closed BOOLEAN NOT NULL DEFAULT FALSE;`,

  // Renderways enrichment fields that were never persisted, because a closed row was
  // always hidden from the Records page and did not need them. A same-day closed row IS
  // on the Records page, so it has to keep its Customer Type.
  `ALTER TABLE daily_call_plan_report_rows
     ADD COLUMN IF NOT EXISTS customer_type TEXT,
     ADD COLUMN IF NOT EXISTS product_serial_no TEXT;`,
];

async function run(): Promise<void> {
  const client = await pool.connect();

  try {
    for (const sql of sqlQueries) {
      await client.query(sql);
    }
    console.log("Applied migration 024_same_day_closed_calls.sql");
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
