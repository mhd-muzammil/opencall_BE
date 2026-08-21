-- Sending a quotation, and what came back.
--
-- A quotation was a document you printed and dealt with off-system: whether it reached the
-- customer, whether they paid, and how long they had been sitting on it lived in somebody's
-- memory. These columns put that on the record, so the list can answer "how many have we
-- sent, who has paid, and who has been quiet for a week" without anyone keeping a
-- parallel spreadsheet.
--
-- All nullable or defaulted, because every quotation already raised was never sent through
-- the system and must not be reported as if it were. NULL sent_at means "not sent from
-- here" — not "sent and we lost the date".
--
-- payment_status is deliberately a plain TEXT with a CHECK rather than an enum: the states
-- a quotation can be in are a business question that will change, and an enum makes adding
-- one a migration with a table rewrite behind it.

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS sent_to TEXT;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS sent_by TEXT;
-- Counts every send including follow-ups, so "sent 3 times, still nothing" is visible.
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS send_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ;

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS paid_by TEXT;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS payment_note TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quotations_payment_status_chk'
  ) THEN
    ALTER TABLE quotations
      ADD CONSTRAINT quotations_payment_status_chk
      CHECK (payment_status IN ('PENDING', 'PAID', 'DECLINED'));
  END IF;
END $$;

-- The list sorts and filters on "sent but not paid", which is the working view.
CREATE INDEX IF NOT EXISTS quotations_payment_status_idx
  ON quotations (payment_status, sent_at);
