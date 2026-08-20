-- Match lookups for the customer email ingest.
--
-- Every ingested message asks two questions of the report rows: "is this WO one of ours?"
-- and, failing that, "has this sender a call open?" Both compare a normalised column:
--
--     WHERE UPPER(TRIM(ticket_id))    = UPPER(TRIM($1))
--     WHERE LOWER(TRIM(customer_mail)) = LOWER(TRIM($1))
--
-- daily_call_plan_report_rows already carries a plain index on ticket_id, but wrapping the
-- column in UPPER(TRIM(...)) makes that index unusable and the planner falls back to a
-- sequential scan of the whole report-row history; customer_mail has no index at all. One
-- scan per lookup is invisible while a sweep carries three or four new messages, and it is
-- what pushed a forty-message catch-up sweep past the IMAP socket's idle ceiling — the
-- connection sat silent for minutes on end while the scans ran, and the server hung up.
--
-- INDEXES ONLY. No column, constraint or row is touched, and nothing outside the two
-- lookups above changes behaviour — the same rows come back, they just come back without
-- reading the table end to end. Same shape as the serial-number index in 039.
--
-- CONCURRENTLY because this runs against a live box: a plain CREATE INDEX holds a lock that
-- blocks report writes for the length of the build, and this table is written every time a
-- report is generated. Concurrent builds take longer and cannot run inside a transaction,
-- which is why each statement stands alone here.

CREATE INDEX CONCURRENTLY IF NOT EXISTS daily_call_plan_report_rows_ticket_upper_idx
  ON daily_call_plan_report_rows (UPPER(TRIM(ticket_id)));

CREATE INDEX CONCURRENTLY IF NOT EXISTS daily_call_plan_report_rows_customer_mail_lower_idx
  ON daily_call_plan_report_rows (LOWER(TRIM(customer_mail)));
