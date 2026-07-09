-- Per-user records-page column layout.
--
-- A row here means the user has customised their records grid. `ordered_columns`
-- is the ordered list of visible report column keys (a subset of the report's
-- DAILY_CALL_PLAN_COLUMNS); any column not listed is hidden for that user. No
-- row = the default full layout (every column, default order). Each user
-- (region admin or super admin) manages only their own row.
CREATE TABLE IF NOT EXISTS user_record_layouts (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ordered_columns JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID
);
