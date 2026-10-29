-- Quotations waiting for approval: raised automatically from the OpenCall report, and not
-- numbered until somebody approves them.
--
-- A 01-Trade work order whose Flex Status is "Visit Estimate" waits as a Visit quotation; one
-- at "Visit Quote To Customer" waits as a Part quotation. Both show in the Quotations section's
-- Waiting Approval box. Approving one is filling in the amount: that raises a real quotation
-- with the next QEV/QEN number, and quotation_id points at it. Removing one keeps the row as
-- REMOVED, so the next report cannot raise the same work order again.
--
-- A table of its own rather than rows in quotations: quotation_no is NOT NULL and UNIQUE, and
-- every reader of quotations (the list, the count boxes, the Sent-folder sweep, the reply
-- watcher) would otherwise have to learn to step around a quotation that does not exist yet.
--
-- One row per kind and work order, for good. ticket_key is the WO as normalizeTicketId writes
-- it (upper-case A-Z and 0-9 only), the same key flex_wip_records.normalized_ticket_id uses.
-- decided_by is the actor string quotations.created_by holds, not a users id: a special-access
-- login is not a user.
--
-- Fully ADDITIVE: one new table, so a re-run at boot is a no-op that locks nothing. Plain TEXT
-- with CHECKs rather than enums, for the reason 061 gives.

CREATE TABLE IF NOT EXISTS quotation_drafts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                TEXT NOT NULL CHECK (kind IN ('PART', 'VISIT')),
  ticket_key          TEXT NOT NULL CHECK (ticket_key <> ''),
  ticket_id           TEXT NOT NULL,
  case_id             TEXT NOT NULL DEFAULT '',
  flex_status         TEXT NOT NULL DEFAULT '',
  work_location       TEXT NOT NULL DEFAULT '',
  customer_name       TEXT NOT NULL DEFAULT '',
  customer_address    TEXT NOT NULL DEFAULT '',
  customer_city       TEXT NOT NULL DEFAULT '',
  customer_state      TEXT NOT NULL DEFAULT '',
  customer_pincode    TEXT NOT NULL DEFAULT '',
  customer_phone      TEXT NOT NULL DEFAULT '',
  customer_email      TEXT NOT NULL DEFAULT '',
  product_description TEXT NOT NULL DEFAULT '',
  model_no            TEXT NOT NULL DEFAULT '',
  serial_no           TEXT NOT NULL DEFAULT '',
  part                TEXT NOT NULL DEFAULT '',
  -- The report that first showed it. No FK: a report is evidence, not an owner.
  report_id           UUID,
  status              TEXT NOT NULL DEFAULT 'WAITING'
                        CHECK (status IN ('WAITING', 'APPROVED', 'REMOVED')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at          TIMESTAMPTZ,
  decided_by          TEXT,
  quotation_id        UUID REFERENCES quotations(id) ON DELETE SET NULL,
  CONSTRAINT quotation_drafts_kind_ticket_uniq UNIQUE (kind, ticket_key)
);
