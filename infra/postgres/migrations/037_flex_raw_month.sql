-- Adds the source month to flex_raw_records so the Closed Calls region cards can show the
-- raw closed count month-wise. The value is a sortable "YYYY-MM" key derived from the raw
-- export's own "Month" column (e.g. "Jun-26" -> "2026-06"); '' when the source month is
-- blank or "Unknown".
--
-- Fully ADDITIVE: an existing row simply keeps '' until the next import re-populates it.
ALTER TABLE flex_raw_records
  ADD COLUMN IF NOT EXISTS source_month TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS flex_raw_records_location_month_status_idx
  ON flex_raw_records (work_location, source_month, status_group);
