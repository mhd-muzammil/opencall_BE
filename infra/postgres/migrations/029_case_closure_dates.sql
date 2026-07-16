-- Imported case closure dates (from the Flex Closure ASP Report Excel).
--
-- The closure date is authoritative external data, not something we derive. It is keyed
-- by BOTH WO id (Ticket No) and Case Id so a closed report row can be matched by either:
-- WO id first, then Case id as a fallback. Re-importing simply upserts the same keys, so
-- the latest upload always wins and report regeneration never loses these values (they
-- live in their own table, not in daily_call_plan_report_rows).
--
-- Fully ADDITIVE: no existing table, column or row is touched.
CREATE TABLE IF NOT EXISTS case_closure_dates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Normalised (trimmed, upper-cased) lookup keys. Either may be blank when the source
  -- row lacks it, but at least one is always present.
  wo_id         TEXT NOT NULL DEFAULT '',
  case_id       TEXT NOT NULL DEFAULT '',
  -- Closure date as a plain calendar date (no time / timezone).
  closure_date  DATE NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per WO id and per Case id, so an import upserts rather than duplicating.
-- Partial unique indexes let the "other" key be blank without colliding on '' .
CREATE UNIQUE INDEX IF NOT EXISTS case_closure_dates_wo_id_uidx
  ON case_closure_dates (wo_id) WHERE wo_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS case_closure_dates_case_id_uidx
  ON case_closure_dates (case_id) WHERE case_id <> '';
