-- The indexes report generation has needed since migration 001.
--
-- Every one of these was created BY HAND on production on 2026-09-01 to end an
-- outage. None of them existed in a migration, so a rebuilt database, a restored
-- backup or a new environment would come up without them and reproduce the outage
-- exactly. That is what this file is for.
--
-- ── The one that caused it ────────────────────────────────────────────────────
--
-- `findFlexWipRecordsByBatchId` is run on every page load, because report
-- generation runs on every page load:
--
--   SELECT ... FROM flex_wip_records WHERE upload_batch_id = $1 ORDER BY row_number
--
-- 001 created flex_wip_records with indexes on normalized_ticket_id and
-- normalized_case_id, and none on upload_batch_id — the only column that query
-- filters by. `upload_batch_id` is a FOREIGN KEY, and in Postgres a foreign key
-- creates a constraint, NOT an index (unlike MySQL, which is where that
-- assumption usually comes from).
--
-- The table is append-only, so the cost grew with it: invisible at ten thousand
-- rows, noticeable at half a million, and at 2.3M rows / 4.6 GB a ~16 minute
-- sequential scan. One of those holds a pool connection; twenty of them and the
-- pool is gone, every other endpoint answers 500, the container healthcheck
-- cannot get a connection either, and Swarm kills a working API. Renderways and
-- call plan records have the identical access pattern and the identical gap.
--
-- ── The rest ─────────────────────────────────────────────────────────────────
--
-- report_history_sessions had NO index beyond its primary key, and
-- `findPreviousFinalReportRowsForManualCarryForward` reads it on every load to
-- find the newest completed report on or before a date. daily_call_plan_reports
-- is what that lookup then orders by.
--
-- flex_wip_records (case_id): `fetchCaseParts` filters
-- `case_id = $1 OR normalized_case_id = $1`. Only the normalised column was
-- indexed, so the OR could not use an index at all and scanned the table.
--
-- Plain CREATE INDEX, not CONCURRENTLY — the same reasoning as 059 and 066. A
-- concurrent build on this database waits for the long-running queries it exists
-- to eliminate, and on 2026-09-01 one run during working hours saturated disk I/O
-- and took the site down for several minutes. A plain build takes a brief
-- exclusive lock and finishes.

DROP INDEX IF EXISTS idx_flex_wip_batch;
CREATE INDEX idx_flex_wip_batch
  ON flex_wip_records (upload_batch_id, row_number);

DROP INDEX IF EXISTS idx_renderways_batch;
CREATE INDEX idx_renderways_batch
  ON renderways_records (upload_batch_id, row_number);

DROP INDEX IF EXISTS idx_call_plan_batch;
CREATE INDEX idx_call_plan_batch
  ON call_plan_records (upload_batch_id, row_number);

-- Partial: the carry-forward lookup only ever asks for COMPLETED sessions that
-- actually produced a report, which is a small slice of a table the FieldEZ
-- worker appends to every fifteen minutes.
DROP INDEX IF EXISTS idx_rhs_completed_report;
CREATE INDEX idx_rhs_completed_report
  ON report_history_sessions (daily_call_plan_report_id, created_at DESC)
  WHERE status = 'COMPLETED' AND daily_call_plan_report_id IS NOT NULL;

DROP INDEX IF EXISTS idx_dcpr_report_date;
CREATE INDEX idx_dcpr_report_date
  ON daily_call_plan_reports (report_date DESC, created_at DESC);

DROP INDEX IF EXISTS idx_flex_wip_case_raw;
CREATE INDEX idx_flex_wip_case_raw
  ON flex_wip_records (case_id);
