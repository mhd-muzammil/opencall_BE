-- Per-credential records-grid column layout for SPECIAL ACCESS logins.
--
-- Special-access credentials are NOT rows in `users`, so they cannot use
-- `user_record_layouts` (whose primary key is a FK to users.id). This table is the
-- exact same idea, keyed by special_access.id instead.
--
-- Fully ADDITIVE: nothing in `users`, `user_record_layouts` or `special_access` is
-- modified, so every existing user / region-admin / super-admin path is untouched.
-- A row here means that credential has customised its records grid; no row = the
-- default full layout.
CREATE TABLE IF NOT EXISTS special_access_record_layouts (
  special_access_id UUID PRIMARY KEY REFERENCES special_access(id) ON DELETE CASCADE,
  ordered_columns   JSONB NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
