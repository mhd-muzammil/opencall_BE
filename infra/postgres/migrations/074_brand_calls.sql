-- Calls for brands other than HP. The first is Acer (asked for on 18 Nov 2026).
--
-- HP calls arrive in the Flex WIP file every 15 minutes. Acer has no file: a SUPER_ADMIN
-- pastes the calls from Acer's portal into the Acer tab of the Records page, one line per
-- call, and this table keeps them. The report generator adds every OPEN call here to each
-- daily report as an ordinary row, Ticket ID "ACER-<case_id>", so the Records table,
-- engineer assignment, the Payroll engineer app and Engineer Productivity handle it with
-- the code that handles HP calls. Morning/Evening status, engineer and remarks live on the
-- report rows and carry forward day to day exactly as HP's do.
--
-- A call stays open until a CLOSED status is set on its report row (Acer has no file to
-- say it closed). closed_at is stamped then; the call stays on that day's report and from
-- the next day the generator stops adding it and the carry-forward closes it, the same way
-- an HP call that left the Flex file closes. Moving the status off CLOSED reopens it.
--
-- A call reopened from the Acer tab (it was closed by mistake, or Acer re-raised the same
-- case) gets reopened_at: the generator then drops a carried "Case-Closed" from its Morning/
-- Evening so the reopened call starts clean. Closing it again clears reopened_at.
--
-- A call deleted from the Acer tab (entered by mistake) gets deleted_at: it is no longer added
-- to reports, and its report rows are excluded so it is not carried forward as a closed call.
-- Pasting the same case again brings it back.
--
-- region_code is the ASP code of the branch that works the call (ASPS01489 = Kanchipuram):
-- the report rows carry it as Work Location, which is what region access, region filters
-- and productivity group by.
--
-- Fully ADDITIVE: one new table, so a re-run at boot is a no-op that locks nothing.

CREATE TABLE IF NOT EXISTS brand_calls (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand              VARCHAR(16) NOT NULL,
  case_id            TEXT NOT NULL,
  ticket_id          TEXT NOT NULL,
  region_code        VARCHAR(32) NOT NULL,
  customer_name      TEXT NOT NULL DEFAULT '',
  call_status        TEXT NOT NULL DEFAULT '',
  service_type       TEXT NOT NULL DEFAULT '',
  model              TEXT NOT NULL DEFAULT '',
  product_category   TEXT NOT NULL DEFAULT '',
  serial_number      TEXT NOT NULL DEFAULT '',
  issue_description  TEXT NOT NULL DEFAULT '',
  warranty_status    TEXT NOT NULL DEFAULT '',
  full_address       TEXT NOT NULL DEFAULT '',
  pincode            TEXT NOT NULL DEFAULT '',
  primary_contact    TEXT NOT NULL DEFAULT '',
  alt_contact        TEXT NOT NULL DEFAULT '',
  source_line        TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         TEXT NOT NULL DEFAULT '',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         TEXT NOT NULL DEFAULT '',
  closed_at          TIMESTAMPTZ,
  closed_status      TEXT,
  closed_by          TEXT,
  CONSTRAINT brand_calls_brand_case_uniq UNIQUE (brand, case_id),
  CONSTRAINT brand_calls_ticket_uniq UNIQUE (ticket_id)
);

CREATE INDEX IF NOT EXISTS brand_calls_open_idx ON brand_calls (brand) WHERE closed_at IS NULL;

ALTER TABLE brand_calls ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ;
ALTER TABLE brand_calls ADD COLUMN IF NOT EXISTS reopened_by TEXT;
ALTER TABLE brand_calls ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE brand_calls ADD COLUMN IF NOT EXISTS deleted_by TEXT;
