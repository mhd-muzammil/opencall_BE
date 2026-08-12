-- Several line items on one quotation.
--
-- A quotation could only ever carry ONE item, because the description, model, serial and
-- amount lived as single columns on `quotations`. A job that replaced two parts had to be
-- issued as two quotations with two running numbers.
--
-- The parent columns STAY and stay populated:
--   * `base_amount` becomes the SUBTOTAL (the sum of the items), so the existing list view
--     and its Total column keep working untouched;
--   * the four description columns keep the FIRST item's values, so anything else reading
--     this table still sees a sensible row.
-- Nothing has to be migrated in lockstep, and an older build reading this table still works.
--
-- GST stays on the parent: one SGST/CGST pair applied to the subtotal, which is how these
-- quotations have always been raised.

CREATE TABLE IF NOT EXISTS quotation_line_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id        UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  -- Display order. The printed sheet must list the items in the order they were entered.
  position            INTEGER NOT NULL DEFAULT 0,

  service_description TEXT NOT NULL DEFAULT '',
  product_description TEXT NOT NULL DEFAULT '',
  model_no            TEXT NOT NULL DEFAULT '',
  serial_no           TEXT NOT NULL DEFAULT '',
  base_amount         NUMERIC(12,2) NOT NULL DEFAULT 0,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS quotation_line_items_quotation_idx
  ON quotation_line_items (quotation_id, position);

-- Backfill: every quotation raised so far becomes a one-item quotation, so re-printing an
-- old one produces exactly the sheet it produced before. Guarded by NOT EXISTS, so running
-- this again cannot duplicate anyone's items.
INSERT INTO quotation_line_items (
  quotation_id, position, service_description, product_description,
  model_no, serial_no, base_amount
)
SELECT q.id, 0, q.service_description, q.product_description,
       q.model_no, q.serial_no, q.base_amount
  FROM quotations q
 WHERE NOT EXISTS (
   SELECT 1 FROM quotation_line_items li WHERE li.quotation_id = q.id
 );
