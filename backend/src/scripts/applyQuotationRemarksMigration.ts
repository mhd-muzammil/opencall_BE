import { closeDatabasePool, pool } from "../config/database.js";

// Migration 073_quotation_remarks.sql — a remark the office types against a quotation, or
// against one waiting for approval, in the Quotations table. See the .sql file.
// Inlined because the deploy image does not ship infra/.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS quotation_remarks (
     id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     quotation_id  UUID REFERENCES quotations(id) ON DELETE CASCADE,
     draft_id      UUID REFERENCES quotation_drafts(id) ON DELETE CASCADE,
     remark        TEXT NOT NULL DEFAULT '',
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_by    TEXT NOT NULL DEFAULT '',
     CONSTRAINT quotation_remarks_one_subject CHECK ((quotation_id IS NULL) <> (draft_id IS NULL)),
     CONSTRAINT quotation_remarks_quotation_uniq UNIQUE (quotation_id),
     CONSTRAINT quotation_remarks_draft_uniq UNIQUE (draft_id)
   );`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 073_quotation_remarks.sql");
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
