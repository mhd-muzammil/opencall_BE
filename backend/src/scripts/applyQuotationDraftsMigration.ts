import { closeDatabasePool, pool } from "../config/database.js";

// Migration 072_quotation_drafts.sql — quotations raised automatically from the OpenCall
// report, waiting for somebody to approve them before they get a number. See the .sql file.
// Inlined because the deploy image does not ship infra/.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS quotation_drafts (
     id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     kind                TEXT NOT NULL CHECK (kind IN ('PART', 'VISIT')),
     ticket_key          TEXT NOT NULL CHECK (ticket_key <> ''),
     ticket_id           TEXT NOT NULL,
     case_id             TEXT NOT NULL DEFAULT '',
     flex_status         TEXT NOT NULL DEFAULT '',
     work_location       TEXT NOT NULL DEFAULT '',
     customer_name       TEXT NOT NULL DEFAULT '',
     customer_address    TEXT NOT NULL DEFAULT '',
     customer_city       TEXT NOT NULL DEFAULT '',
     customer_state      TEXT NOT NULL DEFAULT '',
     customer_pincode    TEXT NOT NULL DEFAULT '',
     customer_phone      TEXT NOT NULL DEFAULT '',
     customer_email      TEXT NOT NULL DEFAULT '',
     product_description TEXT NOT NULL DEFAULT '',
     model_no            TEXT NOT NULL DEFAULT '',
     serial_no           TEXT NOT NULL DEFAULT '',
     part                TEXT NOT NULL DEFAULT '',
     report_id           UUID,
     status              TEXT NOT NULL DEFAULT 'WAITING'
                           CHECK (status IN ('WAITING', 'APPROVED', 'REMOVED')),
     created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     decided_at          TIMESTAMPTZ,
     decided_by          TEXT,
     quotation_id        UUID REFERENCES quotations(id) ON DELETE SET NULL,
     CONSTRAINT quotation_drafts_kind_ticket_uniq UNIQUE (kind, ticket_key)
   );`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 072_quotation_drafts.sql");
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
