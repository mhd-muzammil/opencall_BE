-- When the Sent folder was last asked about a quotation.
--
-- Quotations raised before OpenCall could send carry no send, and there is exactly one
-- honest way to find out whether they went out: look in the mailbox's own Sent folder for
-- the mail. That answer does not come free — it is an IMAP search per quotation per
-- mailbox — so it cannot run for all of them on every three-minute sweep.
--
-- This column is what makes it affordable. The sweep takes a handful that have never been
-- asked about, or were asked long enough ago that the answer may have changed, and leaves
-- the rest for the next pass. A hundred quotations settle themselves over an hour instead
-- of hammering the mail server every three minutes for ever.
--
-- NULL means never asked, which is where every existing row starts.

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS sent_checked_at TIMESTAMPTZ;

-- The sweep's own query: quotations with no send, oldest question first.
CREATE INDEX IF NOT EXISTS quotations_send_check_idx
  ON quotations (sent_checked_at NULLS FIRST)
  WHERE sent_at IS NULL;
