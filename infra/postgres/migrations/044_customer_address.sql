-- 044_customer_address.sql — promote the Flex WIP address columns to real columns.
--
-- WHY THIS EXISTS
-- ---------------
-- The FieldEZ export has carried `Customer Address` and `Common Address` since
-- the beginning, but only `Customer Pincode` was ever promoted out of
-- `raw_row`. Everything address-shaped therefore reads through
-- `raw_row->>'Customer Address'`, which depends on the exact header string
-- FieldEZ happens to emit. A rename there degrades silently: the JSON key
-- simply stops matching, every lookup returns NULL, and nothing fails loudly.
--
-- Promoting them to columns makes the dependency explicit (it lives in the
-- parser's alias list, which is reviewed) and makes coverage queryable without
-- a JSONB scan.
--
-- WHY CITY AND STATE COME ALONG
-- -----------------------------
-- A geocoder disambiguates on them — "Gandhi Road" alone is worthless, "Gandhi
-- Road, Vellore, Tamil Nadu" is not. Adding them now avoids a second migration
-- against the same table for the same feature.
--
-- NO BEHAVIOUR CHANGE. Nothing reads these columns yet. This migration only
-- stops the data being thrown away, so the Phase 2 provider bake-off can be run
-- against real production addresses rather than a single export.
--
-- Idempotent: safe to re-run.

ALTER TABLE flex_wip_records
  ADD COLUMN IF NOT EXISTS customer_address TEXT,
  ADD COLUMN IF NOT EXISTS common_address   TEXT,
  ADD COLUMN IF NOT EXISTS customer_city    TEXT,
  ADD COLUMN IF NOT EXISTS customer_state   TEXT;

COMMENT ON COLUMN flex_wip_records.customer_address IS
  'FieldEZ "Customer Address". Frequently truncated (~62 chars) and occasionally holds a different site than the work order — never trust it over common_address without scoring both (see addressSelector).';

COMMENT ON COLUMN flex_wip_records.common_address IS
  'FieldEZ "Common Address". Measured as the more complete of the two on most rows, and present on rows where customer_address is blank.';

-- Backfill from raw_row so existing rows are usable immediately. The raw JSON
-- is the same data these columns will receive going forward, so this costs one
-- pass and saves waiting a full upload cycle for coverage numbers.
--
-- COALESCE over the alias spellings for the same reason the parser does: the
-- header has been seen with and without spaces across exports.
UPDATE flex_wip_records
   SET customer_address = COALESCE(
         NULLIF(TRIM(raw_row->>'Customer Address'), ''),
         NULLIF(TRIM(raw_row->>'CustomerAddress'), '')
       ),
       common_address = COALESCE(
         NULLIF(TRIM(raw_row->>'Common Address'), ''),
         NULLIF(TRIM(raw_row->>'CommonAddress'), '')
       ),
       customer_city = COALESCE(
         NULLIF(TRIM(raw_row->>'Customer City'), ''),
         NULLIF(TRIM(raw_row->>'CustomerCity'), '')
       ),
       customer_state = COALESCE(
         NULLIF(TRIM(raw_row->>'Customer State'), ''),
         NULLIF(TRIM(raw_row->>'CustomerState'), '')
       )
 WHERE customer_address IS NULL
   AND common_address IS NULL
   AND customer_city IS NULL
   AND customer_state IS NULL;

-- Partial index: the Phase 1 geocoding sweep asks "which records still have an
-- address I have not resolved". Indexing only the rows that HAVE an address
-- keeps it small — a fully blank-address row is never a candidate.
CREATE INDEX IF NOT EXISTS idx_flex_wip_has_address
  ON flex_wip_records (normalized_ticket_id)
  WHERE customer_address IS NOT NULL OR common_address IS NOT NULL;
