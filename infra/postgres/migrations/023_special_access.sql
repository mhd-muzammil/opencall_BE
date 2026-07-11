-- Special Access: scoped logins that are NOT rows in `users`.
--
-- A SUPER_ADMIN can mint a standalone username+password credential and grant it, per credential:
--   * a custom role (access_roles)      -- reusable named bundle of defaults
--   * one or more regions (or all)      -- accessible_regions[] / all_regions
--   * one or more operational sections  -- accessible_sections[]
--   * a data scope                      -- overall | warranty | trade   (enforced server-side)
--   * a permission level                -- view | edit
--
-- This migration is fully ADDITIVE and IDEMPOTENT so it is safe to run on a database that
-- already has an earlier/experimental `special_access` table: existing rows keep working and
-- simply receive sensible defaults for the new columns. Nothing in the `users` table, the
-- `user_role` enum, or any existing feature is modified.

-- ---------------------------------------------------------------------------
-- Custom roles (reusable named permission bundles)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS access_roles (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      TEXT NOT NULL,
  description               TEXT,
  default_sections          TEXT[] NOT NULL DEFAULT '{}',
  default_data_scope        TEXT   NOT NULL DEFAULT 'overall',
  default_permission_level  TEXT   NOT NULL DEFAULT 'view',
  is_active                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_by                UUID REFERENCES users(id),
  updated_by                UUID REFERENCES users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT access_roles_data_scope_chk
    CHECK (default_data_scope IN ('overall', 'warranty', 'trade')),
  CONSTRAINT access_roles_permission_level_chk
    CHECK (default_permission_level IN ('view', 'edit'))
);

CREATE UNIQUE INDEX IF NOT EXISTS access_roles_name_unique_idx
  ON access_roles (lower(name));

-- ---------------------------------------------------------------------------
-- Special access credentials (standalone logins, not in `users`)
-- Full desired shape via IF NOT EXISTS so a fresh DB gets everything; an existing
-- experimental table is then topped up by the ADD COLUMN IF NOT EXISTS block below.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS special_access (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username             TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  role_id              UUID REFERENCES access_roles(id),
  accessible_sections  TEXT[] NOT NULL DEFAULT '{}',
  all_regions          BOOLEAN NOT NULL DEFAULT FALSE,
  accessible_regions   TEXT[] NOT NULL DEFAULT '{}',
  data_scope           TEXT NOT NULL DEFAULT 'overall',
  permission_level     TEXT NOT NULL DEFAULT 'view',
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_by           UUID REFERENCES users(id),
  updated_by           UUID REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Top up an already-existing (experimental) special_access table with the new columns.
ALTER TABLE special_access
  ADD COLUMN IF NOT EXISTS role_id           UUID REFERENCES access_roles(id),
  ADD COLUMN IF NOT EXISTS all_regions       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS data_scope        TEXT NOT NULL DEFAULT 'overall',
  ADD COLUMN IF NOT EXISTS permission_level  TEXT NOT NULL DEFAULT 'view',
  ADD COLUMN IF NOT EXISTS created_by        UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS updated_by        UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Guard columns with CHECKs (added separately so re-runs on an existing table are safe).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'special_access_data_scope_chk'
  ) THEN
    ALTER TABLE special_access
      ADD CONSTRAINT special_access_data_scope_chk
      CHECK (data_scope IN ('overall', 'warranty', 'trade'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'special_access_permission_level_chk'
  ) THEN
    ALTER TABLE special_access
      ADD CONSTRAINT special_access_permission_level_chk
      CHECK (permission_level IN ('view', 'edit'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS special_access_username_unique_idx
  ON special_access (lower(username));

CREATE INDEX IF NOT EXISTS special_access_is_active_idx
  ON special_access (is_active);

-- ---------------------------------------------------------------------------
-- Activity event types for auditing special-access management.
-- (SPECIAL_ACCESS_CREATED / _DELETED may already exist from the experiment.)
-- ---------------------------------------------------------------------------
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'SPECIAL_ACCESS_CREATED';
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'SPECIAL_ACCESS_UPDATED';
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'SPECIAL_ACCESS_DELETED';
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'ACCESS_ROLE_CREATED';
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'ACCESS_ROLE_UPDATED';
ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'ACCESS_ROLE_DELETED';
