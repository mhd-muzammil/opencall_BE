import { closeDatabasePool, pool } from "../config/database.js";

// Mirrors infra/postgres/migrations/023_special_access.sql. Statements are executed
// one-by-one (autocommit) rather than inside a single transaction, because
// `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block on some Postgres
// versions. Every statement is idempotent, so re-running is safe.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS access_roles (
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
  );`,

  `CREATE UNIQUE INDEX IF NOT EXISTS access_roles_name_unique_idx
     ON access_roles (lower(name));`,

  `CREATE TABLE IF NOT EXISTS special_access (
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
  );`,

  `ALTER TABLE special_access
     ADD COLUMN IF NOT EXISTS role_id           UUID REFERENCES access_roles(id),
     ADD COLUMN IF NOT EXISTS all_regions       BOOLEAN NOT NULL DEFAULT FALSE,
     ADD COLUMN IF NOT EXISTS data_scope        TEXT NOT NULL DEFAULT 'overall',
     ADD COLUMN IF NOT EXISTS permission_level  TEXT NOT NULL DEFAULT 'view',
     ADD COLUMN IF NOT EXISTS created_by        UUID REFERENCES users(id),
     ADD COLUMN IF NOT EXISTS updated_by        UUID REFERENCES users(id),
     ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();`,

  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'special_access_data_scope_chk') THEN
       ALTER TABLE special_access ADD CONSTRAINT special_access_data_scope_chk
         CHECK (data_scope IN ('overall', 'warranty', 'trade'));
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'special_access_permission_level_chk') THEN
       ALTER TABLE special_access ADD CONSTRAINT special_access_permission_level_chk
         CHECK (permission_level IN ('view', 'edit'));
     END IF;
   END $$;`,

  `CREATE UNIQUE INDEX IF NOT EXISTS special_access_username_unique_idx
     ON special_access (lower(username));`,

  `CREATE INDEX IF NOT EXISTS special_access_is_active_idx
     ON special_access (is_active);`,

  `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'SPECIAL_ACCESS_CREATED';`,
  `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'SPECIAL_ACCESS_UPDATED';`,
  `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'SPECIAL_ACCESS_DELETED';`,
  `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'ACCESS_ROLE_CREATED';`,
  `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'ACCESS_ROLE_UPDATED';`,
  `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'ACCESS_ROLE_DELETED';`,
];

async function run(): Promise<void> {
  const client = await pool.connect();

  try {
    for (const sql of sqlQueries) {
      await client.query(sql);
    }
    console.log("Applied migration 023_special_access.sql");
  } catch (error) {
    console.error("Migration failed:", error);
    throw error;
  } finally {
    client.release();
  }
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabasePool();
  });
