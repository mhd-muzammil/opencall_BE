-- The index that decides whether engineers get their cases.
--
-- findTicketDetailsByReportId is the second query the Payroll sync runs, and its
-- only caller in the whole codebase. For each of the day's report rows it asks
-- flex_wip_records for the newest record of that ticket:
--
--   LEFT JOIN LATERAL (
--     SELECT customer_address, common_address, customer_pincode
--     FROM flex_wip_records w
--     WHERE w.normalized_ticket_id = <normalised r.ticket_id>
--     ORDER BY w.created_at DESC
--     LIMIT 1
--   ) f ON TRUE
--
-- idx_flex_wip_ticket indexes normalized_ticket_id ALONE, so created_at is not
-- available to the index and "newest" cannot be answered from it. Postgres has
-- to fetch EVERY historical copy of that ticket from the heap and sort them, for
-- every row in the report.
--
-- flex_wip_records is append-only: uploads INSERT without ON CONFLICT and nothing
-- outside the e2e teardown scripts ever deletes. So a ticket accumulates one row
-- per upload it appeared in, and the cost of this query grows every single day
-- with no code change. It crossed the statement_timeout, and from that moment the
-- sync failed on every tick:
--
--   [payroll] auto-sync 2026-09-01 failed: canceling statement due to statement timeout
--
-- Engineers' case lists went empty. Nothing else on the site was affected, because
-- nothing else runs this query.
--
-- With created_at in the index the planner walks straight to the newest row for
-- each ticket and stops. INCLUDE carries the three selected columns so the answer
-- comes out of the index without touching the heap at all.
--
-- Applied by applyFlexWipLatestPerTicketMigration.ts, which inlines this SQL —
-- the deploy image does not ship infra/.

CREATE INDEX IF NOT EXISTS idx_flex_wip_ticket_created
  ON flex_wip_records (normalized_ticket_id, created_at DESC)
  INCLUDE (customer_address, common_address, customer_pincode);

-- idx_flex_wip_ticket is left in place on purpose. Its column is the leading
-- column of the new index, so the planner can serve everything it served — but
-- it is also the index behind idx_flex_wip_has_address's sibling lookups, and
-- dropping an index during an outage fix is a second change to reason about.
