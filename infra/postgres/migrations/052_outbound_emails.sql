-- Compose: send a mail to anyone from a region mailbox.
--
-- `email_replies` (050) can only ever answer a message that already arrived, and only its
-- original sender — that restriction is deliberate and stays. This table is the separate,
-- deliberate outbound path: a Super Admin or Region Admin writes a mail to an address of
-- their choosing and presses Send.
--
-- EVERY send is recorded here BEFORE the SMTP call and updated after, so a mail that left
-- the building is always attributable to a person even if the send then failed — an
-- outbound record with no author must be impossible.
--
-- Fully ADDITIVE: two new tables. Nothing existing is altered.

CREATE TABLE IF NOT EXISTS outbound_emails (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which mailbox it was sent AS. Constrained to a region the sender is scoped to; the
  -- service re-checks that on every request rather than trusting the client.
  region_code   TEXT NOT NULL DEFAULT '',
  from_email    TEXT NOT NULL,

  -- Comma-separated, already normalised and validated by the service. Kept as text because
  -- this is an audit record of what was sent, not a working set to query into.
  to_emails     TEXT NOT NULL,
  cc_emails     TEXT NOT NULL DEFAULT '',
  subject       TEXT NOT NULL DEFAULT '',
  body_text     TEXT NOT NULL DEFAULT '',

  -- Set when Compose was opened from a message, so the thread can be followed later.
  -- ON DELETE SET NULL: losing the inbound row must never erase the record of a sent mail.
  in_reply_to_id UUID REFERENCES inbound_emails(id) ON DELETE SET NULL,

  -- 'QUEUED' the instant the row is written, then 'SENT' or 'FAILED'.
  status        TEXT NOT NULL DEFAULT 'QUEUED',
  message_id    TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',

  -- Who pressed Send. NOT NULL on purpose: there is no unattended path to this table.
  sent_by       UUID NOT NULL REFERENCES users(id),
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS outbound_emails_created_idx
  ON outbound_emails (created_at DESC);
CREATE INDEX IF NOT EXISTS outbound_emails_region_idx
  ON outbound_emails (region_code);
CREATE INDEX IF NOT EXISTS outbound_emails_reply_idx
  ON outbound_emails (in_reply_to_id)
  WHERE in_reply_to_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outbound_emails_status_chk') THEN
    ALTER TABLE outbound_emails ADD CONSTRAINT outbound_emails_status_chk
      CHECK (status IN ('QUEUED', 'SENT', 'FAILED'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS outbound_email_attachments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outbound_email_id  UUID NOT NULL REFERENCES outbound_emails(id) ON DELETE CASCADE,
  filename           TEXT NOT NULL DEFAULT '',
  mime_type          TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes         INTEGER NOT NULL DEFAULT 0,
  content            BYTEA NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS outbound_email_attachments_email_idx
  ON outbound_email_attachments (outbound_email_id);
