-- Add soft-delete flag to daily_call_plan_report_rows.
-- Excluded rows are hidden from today's report view and will NOT be
-- picked up by the carry-forward query, so they will NOT appear in
-- tomorrow's generated call plan.
ALTER TABLE daily_call_plan_report_rows
  ADD COLUMN is_excluded BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for carry-forward query performance
CREATE INDEX idx_daily_report_rows_excluded
  ON daily_call_plan_report_rows(is_excluded)
  WHERE is_excluded = TRUE;
