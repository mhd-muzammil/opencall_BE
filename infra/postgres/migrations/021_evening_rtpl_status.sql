-- Evening (EOD) RTPL status.
--
-- The existing rtpl_status becomes the read-only "Morning" (beginning-of-day)
-- status. evening_rtpl_status is the new, editable end-of-day status that
-- employees fill in during the day. On the next day's file upload it is
-- promoted to Morning (rtpl_status) and reset to empty. It is nullable/blank
-- until an employee works it, and blank at the start of every new day.
ALTER TABLE daily_call_plan_report_rows
  ADD COLUMN IF NOT EXISTS evening_rtpl_status TEXT;
