import { closeDatabasePool, pool } from "../config/database.js";

// Migration 065_closure_case_id_multi_wo.sql — a Case Id may carry several work orders.
//
// 029 created `case_closure_dates_case_id_uidx`, a UNIQUE index on case_id. That asserts
// one closure per customer case, which the vendor's data does not obey: when a customer
// calls back, Flex raises a NEW work order against the SAME case and closes that too.
// A revisit is filed as "WO-035260625-1"; a repeat call gets an unrelated number
// (WO-035252057 / WO-035340079 / WO-035372074 all carry case 5162524657).
//
// The import discards a record whose case is already taken, so those closures were never
// storable. Measured on prod for the 25 Jul – 24 Aug cycle: 19 completed, billable
// closures rejected — every one of them "WO Closed" with a valid closure date, rejected
// only for sharing a case with a call we had already stored. Re-importing could never
// recover them; the row was refused before it reached the table.
//
// Work order is the real identity and keeps its unique index. Case Id keeps a plain
// index — it is still the fallback lookup key, just not a uniqueness claim.
//
// Purely permissive: dropping a uniqueness constraint cannot remove or alter a row.
const sqlQueries = [
  `DROP INDEX IF EXISTS case_closure_dates_case_id_uidx;`,
  `CREATE INDEX IF NOT EXISTS case_closure_dates_case_id_idx
     ON case_closure_dates (case_id) WHERE case_id <> '';`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 065_closure_case_id_multi_wo.sql");
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
