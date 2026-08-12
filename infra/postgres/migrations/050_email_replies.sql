-- Stage 2: replies to a customer email — APPROVAL MODE.
--
-- A draft is generated for a message, a human edits it if they want, and NOTHING leaves the
-- building until that human presses Send. The row records who approved it, so every mail
-- that reached a customer is attributable.
--
-- `region_mailboxes.reply_mode` exists so the two unattended modes can be switched on later
-- (TEMPLATE_AUTO / AI_AUTO); today only APPROVAL is implemented and it is the default.
--
-- Fully ADDITIVE: one new table + one column on this feature's OWN 043 table.
CREATE TABLE IF NOT EXISTS email_replies (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_email_id  UUID NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,

  -- Always the original sender, never free text: a reply cannot be aimed somewhere else.
  to_email          TEXT NOT NULL,
  subject           TEXT NOT NULL DEFAULT '',
  body              TEXT NOT NULL DEFAULT '',

  -- 'TEMPLATE' today; 'AI' once a model key is configured.
  generated_by      TEXT NOT NULL DEFAULT 'TEMPLATE',
  -- 'DRAFT' | 'SENT' | 'FAILED'
  status            TEXT NOT NULL DEFAULT 'DRAFT',

  approved_by       UUID REFERENCES users(id),
  sent_at           TIMESTAMPTZ,
  error             TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One reply per inbound message: a double-click can never send twice.
CREATE UNIQUE INDEX IF NOT EXISTS email_replies_inbound_uidx
  ON email_replies (inbound_email_id);

CREATE INDEX IF NOT EXISTS email_replies_status_idx ON email_replies (status);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_replies_status_chk') THEN
    ALTER TABLE email_replies ADD CONSTRAINT email_replies_status_chk
      CHECK (status IN ('DRAFT', 'SENT', 'FAILED'));
  END IF;
END $$;

ALTER TABLE region_mailboxes
  ADD COLUMN IF NOT EXISTS reply_mode TEXT NOT NULL DEFAULT 'APPROVAL';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'region_mailboxes_reply_mode_chk') THEN
    ALTER TABLE region_mailboxes ADD CONSTRAINT region_mailboxes_reply_mode_chk
      CHECK (reply_mode IN ('APPROVAL', 'TEMPLATE_AUTO', 'AI_AUTO'));
  END IF;
END $$;
