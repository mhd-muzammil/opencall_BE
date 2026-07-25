-- Vendor Access — a SEPARATE scoped-login system (distinct from special_access). A vendor
-- is a standalone username/password login (NOT a users row) that an admin grants a set of
-- vendor views + a view/update permission, and to whom the admin ASSIGNS specific cases.
-- A vendor logs in and sees ONLY their assigned cases (ERP-style vendor portal); admins
-- monitor everything.
--
-- Fully ADDITIVE: no existing table, column, row or type value is altered — only new
-- tables, one new nullable attribution column, and new activity-log enum values.

-- Standalone vendor logins.
CREATE TABLE IF NOT EXISTS vendor_access (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username             TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  -- Which vendor-portal views this login sees (keys from VENDOR_ACCESS_SECTIONS).
  accessible_sections  TEXT[] NOT NULL DEFAULT '{}',
  -- 'view' = read-only; 'update' = may update their own assigned cases.
  permission_level     TEXT NOT NULL DEFAULT 'view',
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_by           UUID REFERENCES users(id),
  updated_by           UUID REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vendor_access_permission_level_chk
    CHECK (permission_level IN ('view', 'update'))
);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_access_username_unique_idx
  ON vendor_access (lower(username));
CREATE INDEX IF NOT EXISTS vendor_access_is_active_idx ON vendor_access (is_active);

-- Case assignments. A "case" is keyed by its NORMALIZED ticket id so an assignment
-- survives daily report regeneration (report row UUIDs are re-minted each day). Raw
-- ticket/case ids are kept for display and case-id fallback matching (same precedent as
-- case_closure_dates). A ticket may be assigned to more than one vendor if needed; it is
-- unique per (vendor, ticket).
CREATE TABLE IF NOT EXISTS vendor_case_assignments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_access_id      UUID NOT NULL REFERENCES vendor_access(id) ON DELETE CASCADE,
  normalized_ticket_id  TEXT NOT NULL DEFAULT '',
  ticket_id             TEXT NOT NULL DEFAULT '',
  normalized_case_id    TEXT NOT NULL DEFAULT '',
  case_id               TEXT NOT NULL DEFAULT '',
  assigned_by           UUID REFERENCES users(id),
  assigned_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_case_assignments_vendor_ticket_uidx
  ON vendor_case_assignments (vendor_access_id, normalized_ticket_id)
  WHERE normalized_ticket_id <> '';
CREATE INDEX IF NOT EXISTS vendor_case_assignments_ticket_idx
  ON vendor_case_assignments (normalized_ticket_id);
CREATE INDEX IF NOT EXISTS vendor_case_assignments_vendor_idx
  ON vendor_case_assignments (vendor_access_id);

-- Attribution for a vendor-made row edit. Parallel to updated_by (users) and
-- updated_by_special_access, because a vendor is neither a user nor a special-access row.
-- ON DELETE SET NULL so a vendor that has edited cases can still be deleted (the edit
-- stays on the report row, only the attribution is cleared).
ALTER TABLE daily_call_plan_report_rows
  ADD COLUMN IF NOT EXISTS updated_by_vendor_access UUID;
DO $$ BEGIN
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
END $$;

-- New audit event types for vendor management + case assignment.
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'VENDOR_ACCESS_CREATED';
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'VENDOR_ACCESS_UPDATED';
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'VENDOR_ACCESS_DELETED';
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'VENDOR_CASE_ASSIGNED';
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'VENDOR_CASE_UNASSIGNED';
