-- Restructure customer feedback into uniform, chartable dropdown values.
--
-- Replaces the free-form (called BOOLEAN + customer_said TEXT) shape with:
--   call_status  — one of a fixed set (Called / Not Reachable / Callback Requested /
--                  Wrong Number / Other)
--   feedback     — one of a fixed set (Satisfied / Not Satisfied / Issue Pending /
--                  No Response / Other)
--   remarks      — optional free text
--
-- Additive column adds (IF NOT EXISTS); the old columns are dropped only after the new
-- ones exist. No other table is touched.
ALTER TABLE case_customer_feedback
  ADD COLUMN IF NOT EXISTS call_status TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS feedback    TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS remarks     TEXT NOT NULL DEFAULT '';

-- Best-effort carry-over of any existing rows: map the old boolean to a call_status and
-- keep the old free text as remarks. Safe to run when the old columns are already gone.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'case_customer_feedback' AND column_name = 'called'
  ) THEN
    UPDATE case_customer_feedback
       SET call_status = CASE WHEN called THEN 'Called' ELSE 'Not Reachable' END
     WHERE call_status = '';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'case_customer_feedback' AND column_name = 'customer_said'
  ) THEN
    UPDATE case_customer_feedback
       SET remarks = customer_said
     WHERE remarks = '' AND customer_said <> '';
  END IF;
END
$$;

ALTER TABLE case_customer_feedback DROP COLUMN IF EXISTS called;
ALTER TABLE case_customer_feedback DROP COLUMN IF EXISTS customer_said;
