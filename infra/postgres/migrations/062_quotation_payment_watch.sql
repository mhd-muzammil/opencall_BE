-- What the customer's reply said, and whether a machine or a person acted on it.
--
-- The quotation can now be marked paid with nobody looking, which makes two things
-- necessary that a manual-only flow never needed. First, telling the two apart: a status a
-- person set and one a rule inferred carry different confidence and only one of them is
-- worth re-checking. Second, keeping the evidence — the reply that triggered it — so the
-- badge can say WHY and the undo behind it is an informed decision rather than a guess.
--
-- payment_source defaults to MANUAL so every quotation that already exists reads as a
-- human's call, which is what it was.

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS payment_source TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS payment_evidence_email_id UUID;
-- Any reply at all, payment-shaped or not: "they wrote back" is worth showing on its own,
-- and it is what stops the follow-up chasing someone who has already answered.
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS reply_seen_at TIMESTAMPTZ;
-- 'NONE' | 'WEAK' | 'STRONG' — WEAK is the one a person still has to look at.
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS payment_signal TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS payment_signal_reasons TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quotations_payment_source_chk'
  ) THEN
    ALTER TABLE quotations
      ADD CONSTRAINT quotations_payment_source_chk
      CHECK (payment_source IN ('MANUAL', 'AUTO'));
  END IF;
END $$;

-- The watcher's own query: sent, not yet settled, ordered by how long they have waited.
CREATE INDEX IF NOT EXISTS quotations_awaiting_reply_idx
  ON quotations (sent_at)
  WHERE sent_at IS NOT NULL AND payment_status = 'PENDING';
