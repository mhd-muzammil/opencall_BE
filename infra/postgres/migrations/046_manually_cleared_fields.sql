-- Which manual fields did a user DELIBERATELY clear on this report row?
--
-- Report rows store an engineer (and location, RCA, remarks, …) as a plain
-- value, and a blank one has always meant the same thing to the generator:
-- "nobody has filled this in yet — carry it forward from the previous report".
-- That is right for a row that was never touched and wrong for a row a user
-- just emptied on purpose.
--
-- The visible failure: an admin disables an engineer, sets that engineer's open
-- calls back to "Entry" and saves. Every page load re-runs
-- POST /reports/daily-call-plan/generate, applyPersistedRowMetadata sees a blank
-- persisted engineer, falls through to the carried-forward value from the
-- previous report, and writes the old name straight back into the row
-- (backfillMissingDailyCallPlanReportRowCarryForward). The name reappears
-- instantly — on a refresh, in incognito, for everyone — and there is no way to
-- un-assign anybody.
--
-- This is the same ambiguity migration 040 removed for the Evening status, so
-- it takes the same shape: record the user's intent instead of inferring it
-- from a blank. A field listed here stays blank through regeneration; setting
-- it to a real value again removes it from the list.
--
-- Scope is per report row, so it expires naturally: tomorrow's report inserts
-- fresh rows with an empty list, and carry-forward reads the (now blank) source
-- value rather than the list.
--
-- No backfill is possible: pre-migration we cannot tell a deliberate clear from
-- a field that was never set. Existing rows start with '[]' and behave exactly
-- as they do today until someone clears a field.
--
-- Fully ADDITIVE: one new column with a default; no existing column is touched.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'daily_call_plan_report_rows'
      AND column_name = 'manually_cleared_fields'
  ) THEN
    ALTER TABLE daily_call_plan_report_rows
      ADD COLUMN manually_cleared_fields JSONB NOT NULL DEFAULT '[]'::jsonb;
  END IF;
END $$;
