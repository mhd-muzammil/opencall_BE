-- Same-day closed calls stay on the Records page until the next day.
--
-- A ticket is "closed" by being absent from the Flex WIP upload. Previously every
-- upload re-ran that check, so a ticket that closed between this morning's upload
-- and this afternoon's re-upload vanished from the Records page mid-day.
--
-- Now the day's FIRST upload is the only one that removes rows from Records. A
-- ticket that disappears on a same-day re-upload is still marked CLOSED (it enters
-- the Closed ledger and the closed counts immediately) but stays listed on the
-- Records page until the next day's first upload. `same_day_closed` marks exactly
-- those rows, and must be persisted: a later re-upload on the same day has to tell
-- a row closed by upload #1 (already off the Records page) apart from one closed by
-- upload #2 (still on it), and both look identical on change_type alone.
--
-- Rows closed by a day's first upload keep same_day_closed = FALSE and leave the
-- Records page immediately, exactly as before.
ALTER TABLE daily_call_plan_report_rows
  ADD COLUMN IF NOT EXISTS same_day_closed BOOLEAN NOT NULL DEFAULT FALSE;

-- customer_type and product_serial_no are Renderways enrichment fields that were
-- never persisted, because a closed row was always hidden from the Records page and
-- did not need them. A same-day closed row IS on the Records page, so it has to keep
-- its Customer Type or isConsumerCase silently falls back to its account-name
-- heuristic and the consumer/commercial split shifts mid-day.
ALTER TABLE daily_call_plan_report_rows
  ADD COLUMN IF NOT EXISTS customer_type TEXT,
  ADD COLUMN IF NOT EXISTS product_serial_no TEXT;
