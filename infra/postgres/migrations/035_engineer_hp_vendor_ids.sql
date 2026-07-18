-- Add HP ID and Vendor ID to engineers. Both optional free text.
--
-- Fully ADDITIVE: new nullable columns default to empty, so every existing engineer keeps
-- working and simply shows a blank HP/Vendor ID until one is entered.
ALTER TABLE engineers
  ADD COLUMN IF NOT EXISTS hp_id     VARCHAR NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS vendor_id VARCHAR NOT NULL DEFAULT '';
