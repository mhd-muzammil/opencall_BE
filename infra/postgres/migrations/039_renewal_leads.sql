-- AMC / Warranty Renewal Pipeline — the sales follow-up state for a warranty-expiring serial.
--
-- The LEADS THEMSELVES ARE DERIVED, never copied: a lead is an hp_warranty_cache row whose
-- end_date falls inside the requested window, joined at read time back to the most recent
-- report row that carried the same serial (for customer/contact/region). Nothing about the
-- warranty or the call is duplicated here, so the list can never drift from its sources and
-- report regeneration cannot lose it.
--
-- This table therefore stores ONLY what a human adds on top of a derived lead: the follow-up
-- status, who owns it and free-text remarks. Keyed by the NORMALISED serial — the same key
-- hp_warranty_cache uses — so it survives report regeneration exactly like case_closure_dates.
--
-- Fully ADDITIVE: one brand-new table plus one index on an existing table (an index only,
-- no column/constraint/data change). No existing table, column or row is modified.
CREATE TABLE IF NOT EXISTS renewal_leads (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Normalised (trimmed, upper-cased) serial: the hp_warranty_cache key.
  serial      TEXT NOT NULL,
  -- Follow-up stage. 'New' is the implicit state of every derived lead that has no row here,
  -- so a row only exists once someone has actually touched the lead.
  status      TEXT NOT NULL DEFAULT 'New',
  -- Free text, NOT a users FK: renewal follow-ups are often done by staff without an
  -- OpenCall login, and we do not want a user deletion to erase sales history.
  owner       TEXT NOT NULL DEFAULT '',
  remarks     TEXT NOT NULL DEFAULT '',
  -- The OpenCall user who last saved this lead (audit only; nullable on purpose).
  updated_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One follow-up row per serial: saving a lead upserts on this key.
CREATE UNIQUE INDEX IF NOT EXISTS renewal_leads_serial_uidx
  ON renewal_leads (serial);

-- The pipeline board groups by status.
CREATE INDEX IF NOT EXISTS renewal_leads_status_idx
  ON renewal_leads (status);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'renewal_leads_status_chk'
  ) THEN
    ALTER TABLE renewal_leads
      ADD CONSTRAINT renewal_leads_status_chk
      CHECK (status IN ('New', 'Contacted', 'Quoted', 'Won', 'Lost', 'Not Interested'));
  END IF;
END $$;

-- Lets the derived-lead query find "the latest report row carrying serial X" without a
-- sequential scan of the whole report-row history. Index ONLY — the table's columns,
-- constraints and rows are untouched, and nothing else reads or writes through it.
CREATE INDEX IF NOT EXISTS daily_call_plan_report_rows_serial_upper_idx
  ON daily_call_plan_report_rows (UPPER(TRIM(product_serial_no)))
  WHERE product_serial_no IS NOT NULL AND TRIM(product_serial_no) <> '';
