-- 045_work_order_geocoding.sql — a coordinate per work order.
--
-- WHY THIS EXISTS
-- ---------------
-- Migration 043 gave the Records page a Distance column measured from the branch
-- office to the customer's PINCODE CENTROID, and documented the cost of that
-- choice honestly: "two customers inside one pincode get the same distance".
--
-- Measured on live Chennai data that cost is larger than it sounds. The spread
-- from a pincode centroid to the furthest post office inside the SAME pincode is
-- 2.72 km at the median, 12.80 km at p90, and 14.43 km in 600053. Two customers
-- in one pincode can be 14 km apart and the report prints them one number. This
-- migration adds the primitive that fixes it: a coordinate per work order.
--
-- WHY KEYED ON TICKET AND NOT CASE
-- --------------------------------
-- The original design keyed this on normalized_case_id. Live data says that is
-- wrong for OpenCall: there are 3,242 distinct tickets against 3,162 distinct
-- cases, so ~80 tickets would collapse onto a shared case id and silently share
-- one coordinate. Everything downstream — daily_call_plan_report_rows, the
-- Location column, the Distance column — joins by TICKET, so the geocode is
-- keyed by ticket too. One less translation step, and no silent collapse.
--
-- WHY earthdistance AND NOT PostGIS
-- ---------------------------------
-- cube + earthdistance ship with stock PostgreSQL contrib, so this runs on the
-- existing image with no image change. The GiST index makes nearest-neighbour an
-- index scan, and spherical distance is accurate to ~0.3% over Tamil Nadu — far
-- inside the error of the geocoding itself. If routing or polygon work later
-- justifies PostGIS, add geography(Point,4326) alongside and backfill from these
-- columns; nothing here is thrown away.
--
-- NOTE ON THE CENTROID TIER: this migration deliberately adds NO centroid table.
-- Migration 043 already built `pincode_geo`, populated it from the All India
-- Pincode Directory through an estimator that survives the directory's corrupt
-- coordinates, and protects hand-corrections with source='manual'. A second
-- centroid store would be a divergent duplicate of a better one.
--
-- Idempotent: safe to re-run.

CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;

-- ---------------------------------------------------------------------------
-- 0. pincode_geo — the centroid tier this cascade falls back on.
--
-- ALSO created by migration 043 (office distance). Both are CREATE TABLE IF NOT
-- EXISTS, so whichever runs first wins and the other is a no-op. The
-- duplication is deliberate: 043 ships a user-facing Distance column whose
-- frontend is not written yet, so it cannot deploy — but the geocoding cascade
-- needs this table now, and a hard dependency on an unshippable migration would
-- block it indefinitely.
--
-- `source` is the load-bearing column. The All India Pincode Directory contains
-- a real minority of corrupt coordinates (observed: a longitude typed 70.181
-- instead of 80.181, a latitude 13.50 instead of 13.05, several sub-office rows
-- snapped onto the coastline). Those are corrected by hand as source='manual',
-- and the importer MUST NOT overwrite a manual row on the next refresh.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pincode_geo (
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
);

CREATE INDEX IF NOT EXISTS idx_pincode_geo_source ON pincode_geo (source);

-- ---------------------------------------------------------------------------
-- 1. geocode_cache — the permanent address cache AND the worker queue.
--
-- One row per DISTINCT address, keyed by a hash of its normalized form, so the
-- same customer site reached by ten work orders costs one provider call. `state`
-- makes this table double as the queue (the same shape as warranty_job_items):
-- the worker claims 'pending' rows with FOR UPDATE SKIP LOCKED, and 'done' rows
-- are the cache.
--
-- 'failed' stays retryable by design — a provider outage must not poison an
-- address forever. 'done' is terminal even when the provider found nothing:
-- precision='none' records "we asked, there is no answer" so we never re-ask.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geocode_cache (
  address_key       TEXT PRIMARY KEY,
  address_text      TEXT NOT NULL,
  pincode           TEXT,

  state             TEXT NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending', 'processing', 'done', 'failed')),

  latitude          DOUBLE PRECISION,
  longitude         DOUBLE PRECISION,
  -- How exact the coordinate is. Drives whether the UI draws a pin or a circle.
  precision         TEXT CHECK (precision IN ('rooftop', 'street', 'locality', 'none')),
  provider          TEXT,
  formatted_address TEXT,
  -- The provider's structured locality. This is what Phase 3 puts in the
  -- Location column — a real area name instead of a pincode's arbitrary post
  -- office name. Nullable: not every provider returns one for every hit.
  locality          TEXT,

  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  locked_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- When the provider actually answered. Separate from updated_at because the
  -- TTL sweep must measure the age of the ANSWER, not of the last bookkeeping
  -- touch, or a requeue would keep resetting the clock.
  resolved_at       TIMESTAMPTZ,

  -- A resolved row must actually carry a coordinate, or it must say 'none'.
  -- Without this a provider bug could quietly store state='done' with NULL
  -- coordinates and every work order behind that address would lose its point.
  CONSTRAINT geocode_cache_resolved_has_point CHECK (
    state <> 'done'
    OR precision = 'none'
    OR (latitude IS NOT NULL AND longitude IS NOT NULL)
  ),
  CONSTRAINT geocode_cache_lat_range CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CONSTRAINT geocode_cache_lng_range CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
);

-- Queue index: the worker orders pending work by created_at.
CREATE INDEX IF NOT EXISTS idx_geocode_cache_queue
  ON geocode_cache (state, created_at);

-- TTL sweep index. Only 'done' rows are ever expired, so the partial index stays
-- small even once the cache is large.
CREATE INDEX IF NOT EXISTS idx_geocode_cache_resolved_at
  ON geocode_cache (resolved_at)
  WHERE state = 'done';

COMMENT ON COLUMN geocode_cache.resolved_at IS
  'When the provider answered. Drives GEOCODE_CACHE_TTL_DAYS expiry; NULL until resolved.';

-- ---------------------------------------------------------------------------
-- 2. work_order_geocodes — the per-ticket projection the app joins against.
--
-- Separate from the cache because the cascade result is per work order, not per
-- address: two tickets can share an address while only one of them has a usable
-- pincode. `source` records WHICH tier answered, so a report can honestly
-- distinguish "this is the rooftop" from "this is a pincode centroid, treat it
-- as a 2 km circle".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_order_geocodes (
  normalized_ticket_id TEXT PRIMARY KEY,
  address_key          TEXT REFERENCES geocode_cache(address_key) ON DELETE SET NULL,

  latitude             DOUBLE PRECISION NOT NULL,
  longitude            DOUBLE PRECISION NOT NULL,
  precision            TEXT NOT NULL
                         CHECK (precision IN ('rooftop', 'street', 'locality', 'pincode_centroid')),
  source               TEXT NOT NULL CHECK (source IN ('provider', 'pincode_centroid')),
  pincode              TEXT,
  -- Which of the two Flex address columns the selector chose. Diagnostics only,
  -- but it is the difference between "why is this call in the wrong place" being
  -- a one-query answer and a guess.
  address_source       TEXT CHECK (address_source IN ('customer', 'common', 'none')),
  resolved_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT work_order_geocodes_lat_range CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT work_order_geocodes_lng_range CHECK (longitude BETWEEN -180 AND 180)
);

CREATE INDEX IF NOT EXISTS idx_work_order_geocodes_address_key
  ON work_order_geocodes (address_key);

-- Lets the coverage query and the Phase 3 upgrade pass find coarse rows without
-- scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_work_order_geocodes_source
  ON work_order_geocodes (source);

-- Spherical nearest-neighbour index. This is what makes
--   ORDER BY ll_to_earth(lat,lng) <-> ll_to_earth($1,$2)
-- an index scan rather than a full sort — i.e. what makes "nearest engineer to
-- this call" viable later without another migration.
CREATE INDEX IF NOT EXISTS idx_work_order_geocodes_earth
  ON work_order_geocodes USING gist (ll_to_earth(latitude, longitude));

-- ---------------------------------------------------------------------------
-- 3. work_order_map_points — the read model.
--
-- Exists so no caller has to know about the cascade: ask for points, get lat/lng
-- plus an accuracy radius to draw. The radii are deliberately pessimistic so a
-- coarse tier can never be mistaken for a doorstep.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW work_order_map_points AS
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
FROM work_order_geocodes g;
