import { closeDatabasePool, pool } from "../config/database.js";

// Migration 033_quotations.sql — customer quotations + a per-financial-year running seq.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS quotations (
     id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     quotation_no       TEXT NOT NULL,
     quotation_date     DATE NOT NULL,
     case_id            TEXT NOT NULL DEFAULT '',
     order_number       TEXT NOT NULL DEFAULT '',
     customer_name      TEXT NOT NULL DEFAULT '',
     customer_address   TEXT NOT NULL DEFAULT '',
     customer_city      TEXT NOT NULL DEFAULT '',
     customer_state     TEXT NOT NULL DEFAULT '',
     customer_pincode   TEXT NOT NULL DEFAULT '',
     customer_phone     TEXT NOT NULL DEFAULT '',
     customer_email     TEXT NOT NULL DEFAULT '',
     service_description TEXT NOT NULL DEFAULT '',
     product_description TEXT NOT NULL DEFAULT '',
     model_no            TEXT NOT NULL DEFAULT '',
     serial_no           TEXT NOT NULL DEFAULT '',
     base_amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
     sgst_percent       NUMERIC(5,2)  NOT NULL DEFAULT 9,
     cgst_percent       NUMERIC(5,2)  NOT NULL DEFAULT 9,
     created_by         TEXT NOT NULL DEFAULT '',
     created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS quotations_quotation_no_uidx
     ON quotations (quotation_no);`,
  `CREATE TABLE IF NOT EXISTS quotation_sequences (
     fin_year   TEXT PRIMARY KEY,
     last_seq   INTEGER NOT NULL DEFAULT 0
   );`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 033_quotations.sql");
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
