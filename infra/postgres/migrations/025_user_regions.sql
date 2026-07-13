-- A REGION_ADMIN can manage multiple regions. users.region_id stays the primary
-- region; this table holds any additional managed regions.
CREATE TABLE IF NOT EXISTS user_regions (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  region_id UUID NOT NULL REFERENCES regions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, region_id)
);
CREATE INDEX IF NOT EXISTS idx_user_regions_user ON user_regions(user_id);
