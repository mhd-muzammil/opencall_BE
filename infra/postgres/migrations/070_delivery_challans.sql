-- Delivery Challan (Warranty Replacement).
--
-- The sheet that goes out with a replacement part, raised from the Delivery Challan
-- section. Numbered per BRANCH and per Indian financial year (April-March), starting at 1
-- — printed as "DC No. 67  2026-2027" — so each of the five branches keeps its own series
-- and every series restarts on April 1.
--
-- Fully ADDITIVE: four new tables and a seed; nothing else is touched.

-- The letterhead each branch prints: company line, address (newline separated), GSTIN/UIN,
-- contact and e-mail. Edited by a super admin from the section's "Branch details" view.
CREATE TABLE IF NOT EXISTS challan_branches (
  branch_key     TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  company_line   TEXT NOT NULL DEFAULT '',
  address_lines  TEXT NOT NULL DEFAULT '',
  gstin          TEXT NOT NULL DEFAULT '',
  contact        TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  -- Both NULL until someone edits the branch: a seeded row was never edited.
  updated_at     TIMESTAMPTZ,
  updated_by     TEXT
);

-- Per-branch, per-financial-year running number. One row per (branch, "2026-2027").
-- Bumped with INSERT ... ON CONFLICT DO UPDATE ... RETURNING inside the challan's own
-- transaction, so two people saving at once can never be handed the same number, and a
-- save that fails gives its number back.
CREATE TABLE IF NOT EXISTS challan_sequences (
  branch_key  TEXT NOT NULL,
  fin_year    TEXT NOT NULL,
  last_seq    INTEGER NOT NULL,
  PRIMARY KEY (branch_key, fin_year)
);

CREATE TABLE IF NOT EXISTS delivery_challans (
  id                BIGSERIAL PRIMARY KEY,
  branch_key        TEXT NOT NULL REFERENCES challan_branches (branch_key),
  -- "2026-2027". Fixed at creation, as are the branch and the number: an edit can move
  -- the date only within this year.
  fin_year          TEXT NOT NULL,
  dc_seq            INTEGER NOT NULL,
  challan_date      DATE NOT NULL,

  -- A COPY of the branch's letterhead as it stood when the challan was raised, so editing
  -- the branch later never rewrites a challan that has already gone out.
  branch_header     JSONB NOT NULL,

  -- Customer block.
  customer_name     TEXT NOT NULL DEFAULT '',
  customer_phone    TEXT NOT NULL DEFAULT '',
  customer_email    TEXT NOT NULL DEFAULT '',
  customer_address  TEXT NOT NULL DEFAULT '',

  -- Newline separated, one line per case / product (a challan can cover several).
  case_ids          TEXT NOT NULL DEFAULT '',
  product_serials   TEXT NOT NULL DEFAULT '',
  product_numbers   TEXT NOT NULL DEFAULT '',
  product_names     TEXT NOT NULL DEFAULT '',

  -- The sheet's reference boxes.
  ref_no_date       TEXT NOT NULL DEFAULT '',
  mode_terms        TEXT NOT NULL DEFAULT '',
  other_references  TEXT NOT NULL DEFAULT '',

  created_by        TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Both NULL until the challan is corrected: an unedited challan has no edit to report.
  updated_by        TEXT,
  updated_at        TIMESTAMPTZ,

  UNIQUE (branch_key, fin_year, dc_seq)
);

-- The list reads newest first.
CREATE INDEX IF NOT EXISTS delivery_challans_created_at_idx
  ON delivery_challans (created_at DESC);

-- The goods table. Free text throughout, as the sheet is (qty is printed "01").
CREATE TABLE IF NOT EXISTS delivery_challan_items (
  id           BIGSERIAL PRIMARY KEY,
  challan_id   BIGINT NOT NULL REFERENCES delivery_challans (id) ON DELETE CASCADE,
  -- Display order: the printed sheet lists the rows in the order they were entered.
  position     INTEGER NOT NULL DEFAULT 0,
  description  TEXT NOT NULL DEFAULT '',
  hsn_sac      TEXT NOT NULL DEFAULT '',
  qty          TEXT NOT NULL DEFAULT '',
  rate         TEXT NOT NULL DEFAULT '',
  per          TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS delivery_challan_items_challan_idx
  ON delivery_challan_items (challan_id, position);

-- The five branches. Hosur is the owner's sample sheet, word for word; Chennai is the
-- office the quotations print (QUOTATION_COMPANY in the web app); Vellore, Salem and
-- Kanchipuram carry only their names until the owner fills them in.
--
-- ON CONFLICT DO NOTHING: once a super admin has edited a branch, re-running this must
-- not put the seeded text back.
INSERT INTO challan_branches (branch_key, name, company_line, address_lines, gstin, contact, email)
VALUES
  ('chennai', 'Chennai', 'RENDERWAYS TECHNOLOGY PVT LTD',
   E'# 25, First Floor, Gandhi Street, Mettukuppam\nMaduravoyal, Chennai - 600095\nTamil Nadu',
   '33AALCR1788A1ZG', '9543095480', 'chennai@renderways.in'),
  ('vellore', 'Vellore', '', '', '', '', ''),
  ('salem', 'Salem', '', '', '', '', ''),
  ('kanchipuram', 'Kanchipuram', '', '', '', '', ''),
  ('hosur', 'Hosur', 'Renderways Technologies –',
   E'L-88A, Rayakottai Hudco, Opp-Murugan Temple\nHosur – 635109',
   '33AALCR1788A1ZG', '+916383428751', 'hosur@renderways.in')
ON CONFLICT (branch_key) DO NOTHING;
