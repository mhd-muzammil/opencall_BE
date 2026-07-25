import { closeDatabasePool, pool } from "../config/database.js";

// Migration 038_vendor_access.sql — the Vendor Access scoped-login system + case
// assignments. Purely additive. Run statement-by-statement (autocommit) because
// ALTER TYPE ... ADD VALUE cannot run inside a transaction block.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS vendor_access (
     id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     username             TEXT NOT NULL,
     password_hash        TEXT NOT NULL,
     accessible_sections  TEXT[] NOT NULL DEFAULT '{}',
     permission_level     TEXT NOT NULL DEFAULT 'view',
     is_active            BOOLEAN NOT NULL DEFAULT TRUE,
     created_by           UUID REFERENCES users(id),
     updated_by           UUID REFERENCES users(id),
     created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'vendor_access_permission_level_chk'
     ) THEN
       ALTER TABLE vendor_access
         ADD CONSTRAINT vendor_access_permission_level_chk
         CHECK (permission_level IN ('view', 'update'));
     END IF;
   END $$;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS vendor_access_username_unique_idx
     ON vendor_access (lower(username));`,
  `CREATE INDEX IF NOT EXISTS vendor_access_is_active_idx ON vendor_access (is_active);`,
  `CREATE TABLE IF NOT EXISTS vendor_case_assignments (
     id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     vendor_access_id      UUID NOT NULL REFERENCES vendor_access(id) ON DELETE CASCADE,
     normalized_ticket_id  TEXT NOT NULL DEFAULT '',
     ticket_id             TEXT NOT NULL DEFAULT '',
     normalized_case_id    TEXT NOT NULL DEFAULT '',
     case_id               TEXT NOT NULL DEFAULT '',
     assigned_by           UUID REFERENCES users(id),
     assigned_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS vendor_case_assignments_vendor_ticket_uidx
     ON vendor_case_assignments (vendor_access_id, normalized_ticket_id)
     WHERE normalized_ticket_id <> '';`,
  `CREATE INDEX IF NOT EXISTS vendor_case_assignments_ticket_idx
     ON vendor_case_assignments (normalized_ticket_id);`,
  `CREATE INDEX IF NOT EXISTS vendor_case_assignments_vendor_idx
     ON vendor_case_assignments (vendor_access_id);`,
  `ALTER TABLE daily_call_plan_report_rows
     ADD COLUMN IF NOT EXISTS updated_by_vendor_access UUID;`,
  `DO $$ BEGIN
     IF EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'daily_call_plan_report_rows_updated_by_vendor_access_fkey'
     ) THEN
       ALTER TABLE daily_call_plan_report_rows
         DROP CONSTRAINT daily_call_plan_report_rows_updated_by_vendor_access_fkey;
     END IF;
     ALTER TABLE daily_call_plan_report_rows
       ADD CONSTRAINT daily_call_plan_report_rows_updated_by_vendor_access_fkey
       FOREIGN KEY (updated_by_vendor_access) REFERENCES vendor_access(id) ON DELETE SET NULL;
   END $$;`,
  `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'VENDOR_ACCESS_CREATED';`,
  `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'VENDOR_ACCESS_UPDATED';`,
  `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'VENDOR_ACCESS_DELETED';`,
  `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'VENDOR_CASE_ASSIGNED';`,
  `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'VENDOR_CASE_UNASSIGNED';`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 038_vendor_access.sql");
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
