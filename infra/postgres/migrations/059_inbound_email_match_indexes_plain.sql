-- 058 again, built plainly rather than concurrently.
--
-- 058 was right about what to index and wrong about how to build it. CREATE INDEX
-- CONCURRENTLY has to wait out every transaction that started before it, and the thing it
-- was waiting for was the very problem it was meant to fix: the ingest's two-minute lookups,
-- running every three minutes. Twenty minutes in, the first index had not been built.
--
-- The caution was misplaced anyway. daily_call_plan_report_rows holds around 138k rows, so
-- an ordinary build takes seconds; report generation waits that long and no longer. A
-- concurrent build trades a few seconds of blocked writes for an unbounded wait, which is
-- only a good trade on a table large enough for the plain build to be the longer of the two.
--
-- DROP before CREATE, without IF NOT EXISTS: a cancelled concurrent build leaves the index
-- present and INVALID, and IF NOT EXISTS would happily skip it and leave the lookups exactly
-- as slow as they are now.

DROP INDEX IF EXISTS daily_call_plan_report_rows_ticket_upper_id_idx;
DROP INDEX IF EXISTS daily_call_plan_report_rows_cust_mail_lower_id_idx;

CREATE INDEX daily_call_plan_report_rows_ticket_upper_id_idx
  ON daily_call_plan_report_rows (UPPER(TRIM(ticket_id)), id DESC);

CREATE INDEX daily_call_plan_report_rows_cust_mail_lower_id_idx
  ON daily_call_plan_report_rows (LOWER(TRIM(customer_mail)), id DESC);

-- Superseded by the composites above, which answer everything they answered.
DROP INDEX IF EXISTS daily_call_plan_report_rows_ticket_upper_idx;
DROP INDEX IF EXISTS daily_call_plan_report_rows_customer_mail_lower_idx;

ANALYZE daily_call_plan_report_rows;
