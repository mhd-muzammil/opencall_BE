import { closeDatabasePool, pool } from "../config/database.js";

// Migration 074_brand_calls.sql — calls for brands other than HP (Acer first), pasted in
// by a SUPER_ADMIN on the Records page's Acer tab. See the .sql file.
// Inlined because the deploy image does not ship infra/.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS brand_calls (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand              VARCHAR(16) NOT NULL,
  case_id            TEXT NOT NULL,
  ticket_id          TEXT NOT NULL,
  region_code        VARCHAR(32) NOT NULL,
  customer_name      TEXT NOT NULL DEFAULT '',
  call_status        TEXT NOT NULL DEFAULT '',
  service_type       TEXT NOT NULL DEFAULT '',
  model              TEXT NOT NULL DEFAULT '',
  product_category   TEXT NOT NULL DEFAULT '',
  serial_number      TEXT NOT NULL DEFAULT '',
  issue_description  TEXT NOT NULL DEFAULT '',
  warranty_status    TEXT NOT NULL DEFAULT '',
  full_address       TEXT NOT NULL DEFAULT '',
  pincode            TEXT NOT NULL DEFAULT '',
  primary_contact    TEXT NOT NULL DEFAULT '',
  alt_contact        TEXT NOT NULL DEFAULT '',
  source_line        TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         TEXT NOT NULL DEFAULT '',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         TEXT NOT NULL DEFAULT '',
  closed_at          TIMESTAMPTZ,
  closed_status      TEXT,
  closed_by          TEXT,
  CONSTRAINT brand_calls_brand_case_uniq UNIQUE (brand, case_id),
  CONSTRAINT brand_calls_ticket_uniq UNIQUE (ticket_id)
);`,
  `CREATE INDEX IF NOT EXISTS brand_calls_open_idx ON brand_calls (brand) WHERE closed_at IS NULL;`,
  `ALTER TABLE brand_calls ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ;`,
  `ALTER TABLE brand_calls ADD COLUMN IF NOT EXISTS reopened_by TEXT;`,
  `ALTER TABLE brand_calls ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;`,
  `ALTER TABLE brand_calls ADD COLUMN IF NOT EXISTS deleted_by TEXT;`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 074_brand_calls.sql");
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
