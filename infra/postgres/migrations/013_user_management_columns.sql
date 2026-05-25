ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_login_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS must_change_password  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS created_by            UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_by            UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS deactivated_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deactivated_by        UUID REFERENCES users(id);

ALTER TABLE regions
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS users_region_role_idx ON users (region_id, role);
CREATE INDEX IF NOT EXISTS users_is_active_idx  ON users (is_active);
