import { closeDatabasePool, pool } from "../config/database.js";

// Migration 053_quotation_line_items.sql — several line items on one quotation.
// Inlined because the deploy image does not ship the repo's infra/ directory.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS quotation_line_items (
     id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     quotation_id        UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
     position            INTEGER NOT NULL DEFAULT 0,
     service_description TEXT NOT NULL DEFAULT '',
     product_description TEXT NOT NULL DEFAULT '',
     model_no            TEXT NOT NULL DEFAULT '',
     serial_no           TEXT NOT NULL DEFAULT '',
     base_amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
     created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,

  `CREATE INDEX IF NOT EXISTS quotation_line_items_quotation_idx
     ON quotation_line_items (quotation_id, position);`,

  // Every quotation raised before this becomes a one-item quotation, so re-printing an old
  // one produces exactly the sheet it produced before. NOT EXISTS makes a re-run a no-op.
  `INSERT INTO quotation_line_items (
     quotation_id, position, service_description, product_description,
     model_no, serial_no, base_amount
   )
   SELECT q.id, 0, q.service_description, q.product_description,
          q.model_no, q.serial_no, q.base_amount
     FROM quotations q
    WHERE NOT EXISTS (
      SELECT 1 FROM quotation_line_items li WHERE li.quotation_id = q.id
    );`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 053_quotation_line_items.sql");
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
