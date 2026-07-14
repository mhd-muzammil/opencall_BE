-- Attribution for report-row edits made by a SPECIAL ACCESS login.
--
-- `daily_call_plan_report_rows.updated_by` is a FK to users(id), and a special-access
-- credential is not a row in `users` — so its id can never be written there. This adds a
-- second, nullable column that points at `special_access` instead. Regular-user edits
-- keep writing `updated_by` exactly as before and leave this NULL.
--
-- Fully ADDITIVE: no existing column, constraint or row is modified.
ALTER TABLE daily_call_plan_report_rows
  ADD COLUMN IF NOT EXISTS updated_by_special_access UUID REFERENCES special_access(id);
