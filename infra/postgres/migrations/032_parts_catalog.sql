-- Parts Catalog: HP Stock RMA parts, owned by OpenCall (independent of inventory).
--
-- Populated by an Excel import (Part / Part Description / Category / Price / HSN Code /
-- IGST / CGST / SGST / EOSL Flag / Validity / Parts Status). An import replaces the whole
-- catalog. Read + search from a super-admin section (and grantable to special access).
--
-- Fully ADDITIVE: a brand-new table; nothing else is touched.
CREATE TABLE IF NOT EXISTS parts_catalog (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_number   TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  price         NUMERIC(12,2) NOT NULL DEFAULT 0,
  hsn_code      TEXT NOT NULL DEFAULT '',
  igst          TEXT NOT NULL DEFAULT '',
  cgst          TEXT NOT NULL DEFAULT '',
  sgst          TEXT NOT NULL DEFAULT '',
  eosl_flag     TEXT NOT NULL DEFAULT '',
  validity      DATE,
  parts_status  TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Search is by part number / description / hsn, so index the part number for lookups.
CREATE INDEX IF NOT EXISTS parts_catalog_part_number_idx
  ON parts_catalog (part_number);
