-- Full message body for the Customer Emails reading pane.
--
-- 043 stored only a 500-character preview, which is enough to triage a list but not to
-- actually READ the mail. The page is now a two-pane client (list + reading pane), so the
-- cleaned full text is kept alongside the preview.
--
-- Stores the CLEANED text (MIME decoded, HTML stripped), not the raw source: the raw form
-- is unreadable and several times larger, and nothing in the app needs it back.
--
-- Fully ADDITIVE: one nullable column on this feature's OWN table (created in 043).
-- No other table is touched.
ALTER TABLE inbound_emails
  ADD COLUMN IF NOT EXISTS body_text TEXT NOT NULL DEFAULT '';
