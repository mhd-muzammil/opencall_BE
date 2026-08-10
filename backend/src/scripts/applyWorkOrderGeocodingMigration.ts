import { closeDatabasePool, pool } from "../config/database.js";

// Mirrors infra/postgres/migrations/045_work_order_geocoding.sql. Every statement
// is idempotent, so re-running is safe.
//
// Adds a coordinate per work order: `geocode_cache` (permanent address cache AND
// worker queue) plus `work_order_geocodes` (the per-ticket projection).
//
// Keyed on normalized_ticket_id, not case id: live data has 3,242 distinct
// tickets against 3,162 distinct cases, so keying by case would silently
// collapse ~80 tickets onto a shared coordinate, and everything downstream joins
// by ticket anyway.
//
// No centroid table here — migration 043's `pincode_geo` already is one, built
// through an estimator that survives the pincode directory's corrupt rows.
const sqlQueries = [
  `CREATE EXTENSION IF NOT EXISTS cube;`,
  `CREATE EXTENSION IF NOT EXISTS earthdistance;`,

  // pincode_geo — the centroid tier this cascade falls back on.
  //
  // ALSO created by migration 043 (office distance). Both are
  // CREATE TABLE IF NOT EXISTS, so whichever runs first wins and the other is a
  // no-op. The duplication is deliberate: 043 ships a user-facing Distance
  // column whose frontend is not written yet, so it cannot deploy — but the
  // geocoding cascade needs this table NOW, and a hard dependency on an
  // unshippable migration would block it indefinitely.
  //
  // `source` is the load-bearing column. The All India Pincode Directory
  // contains a real minority of corrupt coordinates (a longitude typed 70
  // instead of 80 put one Kolathur call 539km away). Those are corrected by
  // hand as source='manual', and the importer must never overwrite them.
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

  // The cache and the queue are one table on purpose: 'pending' rows ARE the
  // queue (claimed with FOR UPDATE SKIP LOCKED), 'done' rows ARE the cache.
  // Keying on the address rather than the ticket is what makes it cheap.
  `CREATE TABLE IF NOT EXISTS geocode_cache (
     address_key       TEXT PRIMARY KEY,
     address_text      TEXT NOT NULL,
     pincode           TEXT,
     state             TEXT NOT NULL DEFAULT 'pending'
                         CHECK (state IN ('pending', 'processing', 'done', 'failed')),
     latitude          DOUBLE PRECISION,
     longitude         DOUBLE PRECISION,
     precision         TEXT CHECK (precision IN ('rooftop', 'street', 'locality', 'none')),
     provider          TEXT,
     formatted_address TEXT,
     locality          TEXT,
     attempts          INTEGER NOT NULL DEFAULT 0,
     last_error        TEXT,
     locked_at         TIMESTAMPTZ,
     created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     resolved_at       TIMESTAMPTZ,
     CONSTRAINT geocode_cache_resolved_has_point CHECK (
       state <> 'done'
       OR precision = 'none'
       OR (latitude IS NOT NULL AND longitude IS NOT NULL)
     ),
     CONSTRAINT geocode_cache_lat_range CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
     CONSTRAINT geocode_cache_lng_range CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
   );`,

  // `locality` is what Phase 3 reads into the Location column. Added defensively
  // for databases where an earlier revision of this table already exists.
  `ALTER TABLE geocode_cache ADD COLUMN IF NOT EXISTS locality TEXT;`,
  `ALTER TABLE geocode_cache ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;`,

  `CREATE INDEX IF NOT EXISTS idx_geocode_cache_queue
     ON geocode_cache (state, created_at);`,

  // Only 'done' rows are ever expired by the TTL sweep, so keep the index partial.
  `CREATE INDEX IF NOT EXISTS idx_geocode_cache_resolved_at
     ON geocode_cache (resolved_at)
     WHERE state = 'done';`,

  `COMMENT ON COLUMN geocode_cache.resolved_at IS
     'When the provider answered. Drives GEOCODE_CACHE_TTL_DAYS expiry; NULL until resolved.';`,

  // The per-ticket projection. `source` records which tier answered so a coarse
  // coordinate is never mistaken for a precise one.
  `CREATE TABLE IF NOT EXISTS work_order_geocodes (
     normalized_ticket_id TEXT PRIMARY KEY,
     address_key          TEXT REFERENCES geocode_cache(address_key) ON DELETE SET NULL,
     latitude             DOUBLE PRECISION NOT NULL,
     longitude            DOUBLE PRECISION NOT NULL,
     precision            TEXT NOT NULL
                            CHECK (precision IN ('rooftop', 'street', 'locality', 'pincode_centroid')),
     source               TEXT NOT NULL CHECK (source IN ('provider', 'pincode_centroid')),
     pincode              TEXT,
     address_source       TEXT CHECK (address_source IN ('customer', 'common', 'none')),
     resolved_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT work_order_geocodes_lat_range CHECK (latitude BETWEEN -90 AND 90),
     CONSTRAINT work_order_geocodes_lng_range CHECK (longitude BETWEEN -180 AND 180)
   );`,

  `CREATE INDEX IF NOT EXISTS idx_work_order_geocodes_address_key
     ON work_order_geocodes (address_key);`,

  `CREATE INDEX IF NOT EXISTS idx_work_order_geocodes_source
     ON work_order_geocodes (source);`,

  // Makes nearest-neighbour an index scan, so "closest engineer to this call"
  // needs no further migration later.
  `CREATE INDEX IF NOT EXISTS idx_work_order_geocodes_earth
     ON work_order_geocodes USING gist (ll_to_earth(latitude, longitude));`,

  // The read model. Accuracy radii are pessimistic on purpose.
  `CREATE OR REPLACE VIEW work_order_map_points AS
   SELECT
     g.normalized_ticket_id,
     g.latitude,
     g.longitude,
     g.precision,
     g.source,
     g.pincode,
     CASE g.precision
       WHEN 'rooftop'          THEN 25
       WHEN 'street'           THEN 150
       WHEN 'locality'         THEN 750
       WHEN 'pincode_centroid' THEN 2000
     END::INTEGER AS accuracy_m,
     g.resolved_at
   FROM work_order_geocodes g;`,
];

async function run(): Promise<void> {
  const client = await pool.connect();

  try {
    for (const sql of sqlQueries) {
      await client.query(sql);
    }
    console.log("Applied migration 045_work_order_geocoding.sql");
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
