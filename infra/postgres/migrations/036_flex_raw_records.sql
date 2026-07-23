-- Imported Flex RAW data (the historical Flex export the "raw data" dashboard is built
-- from). This is the third closed-call source shown on the Closed Calls region cards:
--
--   1. closedCount      — derived live: in yesterday's report, gone from today's Flex WIP
--   2. case_closure_dates — the Flex Closure ASP Report import
--   3. flex_raw_records   — THIS table: the Flex raw export's own Call Status
--
-- Unlike case_closure_dates this keeps one row per source row (no de-duplication): the
-- raw export legitimately repeats a work order across months, and the whole point of the
-- table is to count what the raw file says, not what we think it should say.
--
-- Fully ADDITIVE: no existing table, column or row is touched.
CREATE TABLE IF NOT EXISTS flex_raw_records (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Join keys back to OpenCall. Normalised (trimmed, upper-cased); either may be blank.
  ticket_no      TEXT NOT NULL DEFAULT '',
  case_id        TEXT NOT NULL DEFAULT '',
  -- ASP code exactly as the raw file spells it, upper-cased: ASPS01461, ASPS01465, …
  -- Rows whose Work Location is not an ASP code keep their raw value (or '').
  work_location  TEXT NOT NULL DEFAULT '',
  -- The raw "Call Status" cell, e.g. 'WO CLOSED IN CRM', 'CALL CANCELLED', 'OPEN'.
  call_status    TEXT NOT NULL DEFAULT '',
  -- Bucket derived from call_status: 'closed' | 'cancelled' | 'resolved' | 'open'.
  -- Stored (not computed on read) so the classification rule is frozen at import time
  -- and a count query stays a plain indexed scan.
  status_group   TEXT NOT NULL DEFAULT 'open',
  -- Source "StartDate" when it parses; the raw export has ~12% unusable dates.
  start_date     DATE,
  imported_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The region cards group by work_location and filter on status_group.
CREATE INDEX IF NOT EXISTS flex_raw_records_location_status_idx
  ON flex_raw_records (work_location, status_group);

-- Lookups from a report row back into the raw export.
CREATE INDEX IF NOT EXISTS flex_raw_records_ticket_idx
  ON flex_raw_records (ticket_no) WHERE ticket_no <> '';
CREATE INDEX IF NOT EXISTS flex_raw_records_case_idx
  ON flex_raw_records (case_id) WHERE case_id <> '';
