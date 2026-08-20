-- Match lookups for the email ingest, take two: carry the sort key as well.
--
-- 057 indexed the two normalised columns the ingest matches on. It was not enough, and
-- findRowByCustomerEmail went on taking over two minutes per message. Both lookups end:
--
--     WHERE LOWER(TRIM(customer_mail)) = $1 ... ORDER BY id DESC LIMIT 1
--
-- An index on the expression alone can find the matching rows but cannot deliver them in id
-- order, so the planner weighs "index scan, then sort" against "walk the primary key
-- backwards and stop at the first row that matches" — and with LIMIT 1 the second looks
-- cheap, because it expects to stop early. For a sender who has no call open it never stops
-- early: it reads the entire report-row history, newest to oldest, and finds nothing. That
-- is the common case, since most people who write in are not in the report at all.
--
-- Carrying id in the index removes the choice. Rows for one email address are already in id
-- order inside the index, so LIMIT 1 is the first entry read — no sort, no table walk, and
-- the same answer either way.
--
-- ANALYZE at the end because an expression index has no statistics until it is analysed,
-- and a planner without statistics is what made the wrong choice look cheap.
--
-- INDEXES ONLY. No column, constraint or row is touched. The 057 indexes are dropped after
-- the new ones exist: a composite on (expr, id) serves everything the expr-only index did,
-- so keeping both would only cost write time on every report generation.

CREATE INDEX CONCURRENTLY IF NOT EXISTS daily_call_plan_report_rows_ticket_upper_id_idx
  ON daily_call_plan_report_rows (UPPER(TRIM(ticket_id)), id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS daily_call_plan_report_rows_cust_mail_lower_id_idx
  ON daily_call_plan_report_rows (LOWER(TRIM(customer_mail)), id DESC);

DROP INDEX CONCURRENTLY IF EXISTS daily_call_plan_report_rows_ticket_upper_idx;
DROP INDEX CONCURRENTLY IF EXISTS daily_call_plan_report_rows_customer_mail_lower_idx;

ANALYZE daily_call_plan_report_rows;
