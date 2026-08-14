-- The raw export's WO Closed date, per row.
--
-- The Closed Calls date filter could scope OpenCall's own ledger and the FieldEZ
-- closure import to a single day, but the raw-data line could only ever answer
-- month-level ("whole of Aug") because the raw feed never carried a date. The
-- raw-data project now emits closedOn per row (its source's "WO Closed" column),
-- and this column stores it so the raw line can answer the same day the other
-- two lines do.
--
-- NULL when the source row had no usable date (~20% carry 'YES'/'NO'/blank) —
-- those rows stay countable month-level but are invisible to any day range,
-- which the summary reports as `undatedClosed` so the card can say so.

ALTER TABLE flex_raw_records
  ADD COLUMN IF NOT EXISTS closed_on DATE;

CREATE INDEX IF NOT EXISTS flex_raw_records_closed_on_idx
  ON flex_raw_records (closed_on);
