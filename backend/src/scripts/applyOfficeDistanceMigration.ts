import { closeDatabasePool, pool } from "../config/database.js";

// Mirrors infra/postgres/migrations/043_office_distance.sql. Every statement is
// idempotent, so re-running is safe.
const sqlQueries = [
  // The ORIGIN: one row per ASP branch office. Keyed by asp_code because report
  // rows carry the work-location code directly, unlike region codes which need a
  // translation step that is a known sharp edge in this codebase.
  `CREATE TABLE IF NOT EXISTS region_offices (
     asp_code    TEXT PRIMARY KEY,
     label       TEXT NOT NULL,
     latitude    NUMERIC(9, 6) NOT NULL,
     longitude   NUMERIC(9, 6) NOT NULL,
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_by  UUID REFERENCES users(id),
     CONSTRAINT region_offices_lat_range CHECK (latitude BETWEEN -90 AND 90),
     CONSTRAINT region_offices_lng_range CHECK (longitude BETWEEN -180 AND 180)
   );`,

  // Chennai only for now. The other four branches render a blank Distance cell
  // until their coordinates are supplied — a guessed origin would silently
  // mis-rank every call in that region.
  `INSERT INTO region_offices (asp_code, label, latitude, longitude)
   VALUES ('ASPS01461', 'Chennai - Maduravoyal', 13.054517, 80.177834)
   ON CONFLICT (asp_code) DO NOTHING;`,

  // The DESTINATION: one coordinate per pincode. `source` protects hand-entered
  // corrections from being wiped by the next directory import — the government
  // file carries a real minority of corrupt coordinates that must be fixed by
  // hand, and losing those on every refresh would make the table untrustworthy.
  `CREATE TABLE IF NOT EXISTS pincode_geo (
     pincode       TEXT PRIMARY KEY,
     latitude      NUMERIC(9, 6) NOT NULL,
     longitude     NUMERIC(9, 6) NOT NULL,
     area_name     TEXT,
     district      TEXT,
     state_name    TEXT,
     source        TEXT NOT NULL DEFAULT 'directory'
                     CHECK (source IN ('directory', 'manual')),
     offices_used  INTEGER,
     offices_total INTEGER,
     spread_km     NUMERIC(6, 2),
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT pincode_geo_lat_range CHECK (latitude BETWEEN -90 AND 90),
     CONSTRAINT pincode_geo_lng_range CHECK (longitude BETWEEN -180 AND 180),
     CONSTRAINT pincode_geo_six_digits CHECK (pincode ~ '^[0-9]{6}$')
   );`,

  `CREATE INDEX IF NOT EXISTS idx_pincode_geo_source ON pincode_geo (source);`,

  // Frozen onto the report row like `location`, so a historical report keeps
  // showing what the dispatcher actually saw. Nullable: an unknown office or an
  // unresolvable pincode gives a blank cell, never a fabricated number.
  `ALTER TABLE daily_call_plan_report_rows
     ADD COLUMN IF NOT EXISTS distance_km      NUMERIC(6, 1),
     ADD COLUMN IF NOT EXISTS distance_bearing TEXT;`,

  // Saved layouts are a whitelist of VISIBLE columns, so without this a user who
  // customised their grid would never see Distance — and nothing distinguishes
  // "I hid this" from "this did not exist yet". Recording the catalog at save
  // time makes that distinction possible.
  `ALTER TABLE user_record_layouts
     ADD COLUMN IF NOT EXISTS known_columns JSONB;`,

  // Real routed distance per (office, pincode). A flat straight-line multiplier
  // misses by 5.2km on average because the true road/straight ratio runs
  // 1.11-1.94 and falls with distance — highways for long runs, winding streets
  // for short ones. Affordable because five offices against a couple of hundred
  // live pincodes is only a few hundred routes.
  `CREATE TABLE IF NOT EXISTS office_pincode_distances (
     asp_code    TEXT NOT NULL,
     pincode     TEXT NOT NULL,
     road_km     NUMERIC(7, 1) NOT NULL,
     provider    TEXT NOT NULL DEFAULT 'osrm',
     computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (asp_code, pincode),
     CONSTRAINT office_pincode_distances_positive CHECK (road_km >= 0)
   );`,
];

async function run(): Promise<void> {
  const client = await pool.connect();

  try {
    for (const sql of sqlQueries) {
      await client.query(sql);
    }
    console.log("Applied migration 043_office_distance.sql");
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
  .finally(closeDatabasePool);
