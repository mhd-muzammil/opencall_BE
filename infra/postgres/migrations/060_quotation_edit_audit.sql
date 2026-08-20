-- Who last changed a quotation, and when.
--
-- A quotation is a priced document that goes to a customer under a running number, and
-- that number does not change when the sheet is corrected — so without these two columns
-- the record simply becomes whatever it was last saved as, with nothing to say it moved.
-- `created_by` already answers "who issued this"; these answer "and who touched it since".
--
-- Both nullable: every existing row was issued and never edited, and stamping them with
-- the creator's name and time would be inventing an edit that did not happen. NULL here
-- means exactly that — untouched since it was raised.

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS updated_by TEXT;
