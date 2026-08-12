-- Customer email ingest — Stage 1: READ ONLY.
--
-- A worker polls each region's cPanel mailbox over IMAP, stores the new messages and tries
-- to match each one to an open call. NOTHING is ever sent from these tables in Stage 1;
-- there is deliberately no reply/outbox table yet.
--
-- THE WATERMARK IS THE SAFETY RAIL. The live mailboxes hold years of history (3.5k-6.5k
-- messages each). `ingest_from` is stamped when a mailbox is registered and the worker only
-- ever reads messages received AT OR AFTER it, so the back catalogue is never touched — and
-- when replies are switched on later, no historical customer can be auto-answered.
--
-- Fully ADDITIVE: two brand-new tables; no existing table, column or row is touched.
CREATE TABLE IF NOT EXISTS region_mailboxes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Region label as the app knows it (e.g. 'SALEM'); free text so a mailbox can be
  -- registered before its region row exists.
  region_code    TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  -- Only mail received at or after this instant is ever ingested. Set once, at registration.
  ingest_from    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_polled_at TIMESTAMPTZ,
  last_error     TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS region_mailboxes_email_uidx
  ON region_mailboxes (lower(email));

CREATE TABLE IF NOT EXISTS inbound_emails (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_email   TEXT NOT NULL,
  region_code     TEXT NOT NULL DEFAULT '',
  -- RFC 5322 Message-ID. The dedupe key: a re-poll must never store a message twice.
  message_id      TEXT NOT NULL,
  imap_uid        BIGINT,

  from_email      TEXT NOT NULL DEFAULT '',
  from_name       TEXT NOT NULL DEFAULT '',
  subject         TEXT NOT NULL DEFAULT '',
  -- Trimmed plain-text preview, not the whole body: enough to triage in the UI without
  -- turning this table into a mail store.
  body_preview    TEXT NOT NULL DEFAULT '',
  received_at     TIMESTAMPTZ NOT NULL,

  -- Matching back to a call.
  matched_ticket_id TEXT NOT NULL DEFAULT '',
  matched_case_id   TEXT NOT NULL DEFAULT '',
  -- 'WO_NUMBER' (found in subject/body) | 'CUSTOMER_EMAIL' (sender is a known contact) | 'NONE'
  match_method      TEXT NOT NULL DEFAULT 'NONE',
  -- 'HIGH' | 'LOW' | 'NONE'. Only HIGH may ever be auto-answered once replies exist.
  match_confidence  TEXT NOT NULL DEFAULT 'NONE',

  -- True when the message carries Auto-Submitted / X-Autoreply / Precedence: bulk.
  -- Replying to one of these is how auto-responder loops start, so it is recorded at
  -- ingest and such messages are excluded from any future reply path.
  is_auto_reply   BOOLEAN NOT NULL DEFAULT FALSE,
  -- 'NEW' | 'REVIEWED' | 'IGNORED' — human triage state.
  status          TEXT NOT NULL DEFAULT 'NEW',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per message per mailbox, so re-polling is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS inbound_emails_msgid_uidx
  ON inbound_emails (mailbox_email, message_id);

CREATE INDEX IF NOT EXISTS inbound_emails_received_idx
  ON inbound_emails (received_at DESC);
CREATE INDEX IF NOT EXISTS inbound_emails_status_idx
  ON inbound_emails (status);
CREATE INDEX IF NOT EXISTS inbound_emails_ticket_idx
  ON inbound_emails (matched_ticket_id) WHERE matched_ticket_id <> '';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inbound_emails_status_chk') THEN
    ALTER TABLE inbound_emails ADD CONSTRAINT inbound_emails_status_chk
      CHECK (status IN ('NEW', 'REVIEWED', 'IGNORED'));
  END IF;
END $$;
