-- Customer feedback captured against a closed call (from the Closed Calls table).
--
-- One feedback record per case, keyed by BOTH WO id and Case id so a report row can be
-- matched by either (WO id first, then Case id) — the same matching the closure-date
-- import uses. Re-saving upserts, so the latest feedback always wins. Lives in its own
-- table, so report regeneration never loses it.
--
-- `called` = was the customer called (Yes/No). `customer_said` = free-text of what the
-- customer said. The Customer Status column is derived from these on read.
--
-- Fully ADDITIVE: no existing table, column or row is touched.
CREATE TABLE IF NOT EXISTS case_customer_feedback (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_id          TEXT NOT NULL DEFAULT '',
  case_id        TEXT NOT NULL DEFAULT '',
  called         BOOLEAN NOT NULL DEFAULT FALSE,
  customer_said  TEXT NOT NULL DEFAULT '',
  updated_by     TEXT NOT NULL DEFAULT '',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per WO id and per Case id, so a save upserts rather than duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS case_customer_feedback_wo_id_uidx
  ON case_customer_feedback (wo_id) WHERE wo_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS case_customer_feedback_case_id_uidx
  ON case_customer_feedback (case_id) WHERE case_id <> '';
