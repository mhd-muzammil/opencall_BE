-- Original-fidelity rendering for the Customer Emails reader.
--
-- Until now only a flattened plain-text body was kept, so a mail that arrived as HTML —
-- which is nearly every mail HP sends — lost its layout, its tables and its signature
-- images, and inline pictures showed as a bare "[cid:image001.png@01DD2A69.E32ECA10]".
-- Storing the HTML part and the attachment bytes lets the reading pane show the message
-- as the sender actually wrote it.
--
-- `body_text` STAYS and stays authoritative for matching and escalation detection: those
-- rules are tuned against plain text and must not start seeing markup. The HTML is for
-- display only.
--
-- Fully ADDITIVE: one nullable-by-default column plus one new table of this feature's own.

ALTER TABLE inbound_emails
  ADD COLUMN IF NOT EXISTS body_html TEXT NOT NULL DEFAULT '';

-- True when the message had no HTML part at all, so the reader can render the plain-text
-- body without first guessing why `body_html` is empty.
ALTER TABLE inbound_emails
  ADD COLUMN IF NOT EXISTS has_attachments BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS inbound_email_attachments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_email_id  UUID NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,

  -- RFC 2392 Content-ID with the angle brackets stripped. Non-empty only for the inline
  -- pictures an HTML body refers to as src="cid:...", which is how the signature logo is
  -- put back in place at render time.
  content_id        TEXT NOT NULL DEFAULT '',
  filename          TEXT NOT NULL DEFAULT '',
  mime_type         TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes        INTEGER NOT NULL DEFAULT 0,
  -- Inline pictures are part of the body; the rest are the paperclip list.
  is_inline         BOOLEAN NOT NULL DEFAULT FALSE,
  content           BYTEA NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS inbound_email_attachments_email_idx
  ON inbound_email_attachments (inbound_email_id);

-- The lookup the renderer does for every cid: reference in the body.
CREATE INDEX IF NOT EXISTS inbound_email_attachments_cid_idx
  ON inbound_email_attachments (inbound_email_id, content_id)
  WHERE content_id <> '';
