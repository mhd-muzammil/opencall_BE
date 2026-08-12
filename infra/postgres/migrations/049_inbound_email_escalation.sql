-- Escalation flag on an inbound customer email.
--
-- HP calls an escalated call an "Elevation", and real escalations arrive from an
-- "Escalation Manager". Detecting that at ingest lets the Customer Emails list surface the
-- ones a coordinator must pick up first instead of burying them in routine HP traffic.
--
-- Stored (not derived on read) so the classification a message was flagged under is frozen
-- at ingest and a list query stays a plain indexed scan.
--
-- Fully ADDITIVE: two nullable columns on this feature's OWN table (created in 043).
ALTER TABLE inbound_emails
  ADD COLUMN IF NOT EXISTS escalation_level TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS escalation_reasons TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS inbound_emails_escalation_idx
  ON inbound_emails (escalation_level) WHERE escalation_level <> 'NONE';
