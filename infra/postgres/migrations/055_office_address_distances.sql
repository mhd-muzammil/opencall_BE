-- Routed road distance per (office, geocoded address) — the exact-address tier's
-- counterpart of office_pincode_distances.
--
-- The precise tier only ever shows a provider coordinate once its ROAD distance
-- exists: swapping a routed centroid figure for a straight-line "precise" one
-- would trade a good number for a worse-looking one. So each provider-resolved
-- address is routed from every branch office (a few thousand pairs at most,
-- free on OSRM) and stored here, keyed by the geocode_cache address key so one
-- address shared by many work orders is routed once.
--
-- ON DELETE CASCADE: an address expired out of the cache (vendor storage TTL)
-- must take its routes with it, or a re-geocode that moves the coordinate would
-- keep serving the old route.

CREATE TABLE IF NOT EXISTS office_address_distances (
  asp_code    TEXT NOT NULL,
  address_key TEXT NOT NULL REFERENCES geocode_cache(address_key) ON DELETE CASCADE,
  road_km     NUMERIC(7, 1) NOT NULL,
  provider    TEXT NOT NULL DEFAULT 'osrm',
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (asp_code, address_key),
  CONSTRAINT office_address_distances_positive CHECK (road_km >= 0)
);
