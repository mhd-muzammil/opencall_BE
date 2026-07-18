-- Per-region "Final EOD" day boundary for engineer productivity.
--
-- Each of the 5 regions closes its working day at its own time. Closing
-- freezes that region's productivity for the day into a persisted snapshot;
-- edits made afterwards no longer change the frozen day (they roll into the
-- region's next working day). A SUPER_ADMIN can reopen a mistakenly-closed
-- region-day, which deletes the snapshot and puts the region back live.
--
-- Fully ADDITIVE: two new tables; nothing else is touched.
CREATE TABLE IF NOT EXISTS region_eod_state (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id    UUID NOT NULL REFERENCES regions(id),
  working_date DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  closed_at    TIMESTAMPTZ,
  closed_by    UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (region_id, working_date)
);

CREATE INDEX IF NOT EXISTS idx_region_eod_state_date
  ON region_eod_state (working_date);

-- The frozen per-engineer productivity for a closed region-day. Payload is the
-- shared EngineerProductivityResult, computed by the SAME shared function the
-- live dashboard uses, at the moment of closing.
CREATE TABLE IF NOT EXISTS region_productivity_snapshot (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id    UUID NOT NULL REFERENCES regions(id),
  working_date DATE NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (region_id, working_date)
);

CREATE INDEX IF NOT EXISTS idx_region_productivity_snapshot_date
  ON region_productivity_snapshot (working_date);
