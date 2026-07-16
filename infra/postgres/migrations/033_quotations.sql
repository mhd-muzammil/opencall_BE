-- Quotations issued to customers (RENDERWAYS quotation format).
--
-- Customer + product details are captured (auto-filled from a report row by Case ID / WO
-- where available, then editable); the amount, service description and GST are entered.
-- The running quotation number (RTPL/<fin-year>/QEN/<seq>) is assigned server-side.
--
-- Fully ADDITIVE: a new table + a sequence; nothing else is touched.
CREATE TABLE IF NOT EXISTS quotations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Human-facing running number, e.g. RTPL/25-26/QEN/271. Unique.
  quotation_no       TEXT NOT NULL,
  quotation_date     DATE NOT NULL,

  -- Case linkage (either may be blank).
  case_id            TEXT NOT NULL DEFAULT '',
  order_number       TEXT NOT NULL DEFAULT '',

  -- Customer block.
  customer_name      TEXT NOT NULL DEFAULT '',
  customer_address   TEXT NOT NULL DEFAULT '',
  customer_city      TEXT NOT NULL DEFAULT '',
  customer_state     TEXT NOT NULL DEFAULT '',
  customer_pincode   TEXT NOT NULL DEFAULT '',
  customer_phone     TEXT NOT NULL DEFAULT '',
  customer_email     TEXT NOT NULL DEFAULT '',

  -- Line item.
  service_description TEXT NOT NULL DEFAULT '',
  product_description TEXT NOT NULL DEFAULT '',
  model_no            TEXT NOT NULL DEFAULT '',
  serial_no           TEXT NOT NULL DEFAULT '',

  -- Money (rupees). GST percentages default to the intra-state 9% + 9%.
  base_amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
  sgst_percent       NUMERIC(5,2)  NOT NULL DEFAULT 9,
  cgst_percent       NUMERIC(5,2)  NOT NULL DEFAULT 9,

  created_by         TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS quotations_quotation_no_uidx
  ON quotations (quotation_no);

-- Per-financial-year running sequence for the QEN number. One row per fin-year.
CREATE TABLE IF NOT EXISTS quotation_sequences (
  fin_year   TEXT PRIMARY KEY,
  last_seq   INTEGER NOT NULL DEFAULT 0
);
