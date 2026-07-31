-- Flex Closure ASP Report: carry the whole closure record, not just the date.
--
-- 029 stored only (wo_id, case_id, closure_date). The hourly auto-sync needs the rest of
-- the row so the Open Call Report can show the vendor's own closure status, and so region
-- attribution stops depending on tracing the key back through report rows.
--
-- Additive, plus ONE relaxation: closure_date loses NOT NULL.
--   Why: in the real workbooks 9 of 74 rows are "Closed - Canceled" with a blank Closure
--   Date. They ARE closed in Flex and must be stored. `closed_on` is the closure date when
--   present, otherwise the Activity Time's calendar day — so every stored row still has a
--   day to be counted under.
ALTER TABLE case_closure_dates
  ALTER COLUMN closure_date DROP NOT NULL,
  -- The day this closure belongs to: closure_date, else date(activity_time).
  ADD COLUMN IF NOT EXISTS closed_on            DATE,
  -- Verbatim vendor status ("WO Closed", "Closed - Canceled", …) — overlaid onto the
  -- report's Flex Status cell at serve time. Never written into report rows.
  ADD COLUMN IF NOT EXISTS closure_status       TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS status_remarks       TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS failure_code         TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS resolution_comments  TEXT NOT NULL DEFAULT '',
  -- ASP code straight from the file, so the reconciliation view does not have to join
  -- back to daily_call_plan_report_rows to work out which region a closure belongs to.
  ADD COLUMN IF NOT EXISTS work_location        TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS asp_name             TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS activity_time        TIMESTAMPTZ,
  -- When this row last arrived, and from which import. Drives the "Auto-synced HH:mm"
  -- freshness line — a silently dead worker otherwise keeps serving stale statuses.
  ADD COLUMN IF NOT EXISTS imported_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS import_source        TEXT NOT NULL DEFAULT 'MANUAL';

-- Backfill: every pre-existing row was imported with a non-null closure_date.
UPDATE case_closure_dates SET closed_on = closure_date WHERE closed_on IS NULL;

-- The reconciliation view is always "for one day", so this is the hot filter.
CREATE INDEX IF NOT EXISTS case_closure_dates_closed_on_idx ON case_closure_dates (closed_on);
