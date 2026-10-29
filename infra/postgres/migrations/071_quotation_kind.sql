-- Two kinds of quotation in the one Quotations section: a Visit quotation (the service
-- charge before an engineer goes out) and a Part quotation (the part estimate after).
--
-- Each kind prints its own sheet and runs its own number series: a Part keeps
-- RTPL/<fin-year>/QEN/<seq> from quotation_sequences, a Visit takes RTPL/<fin-year>/QEV/<seq>
-- from the new quotation_visit_sequences, starting from 1 each financial year. The two
-- series never produce the same text, so quotations_quotation_no_uidx keeps guarding both.
--
-- kind defaults to 'PART': every quotation raised before this was a Part quotation, and an
-- INSERT from a build that does not know the column must keep working. A plain TEXT with a
-- CHECK rather than an enum, for the reason 061 gives.
--
-- Fully ADDITIVE: one column, one constraint, one table.

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'PART';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quotations_kind_chk'
  ) THEN
    ALTER TABLE quotations
      ADD CONSTRAINT quotations_kind_chk
      CHECK (kind IN ('PART', 'VISIT'));
  END IF;
END $$;

-- Per-financial-year running sequence for the QEV number. One row per fin-year.
CREATE TABLE IF NOT EXISTS quotation_visit_sequences (
  fin_year   TEXT PRIMARY KEY,
  last_seq   INTEGER NOT NULL DEFAULT 0
);
