-- When was the Evening (EOD) status itself last edited by a user?
--
-- The same-day Evening authority decides whether a report row "speaks for
-- itself" — i.e. whether its blank Evening is a deliberate clear that must
-- stand, or a gap to be healed from an Evening the same user set on another of
-- today's reports — by comparing the row's edit time against the authority
-- entry's. It used rows.updated_at, which is stamped for EVERY manual field
-- edit, so "someone changed the Engineer at 19:03" was indistinguishable from
-- "someone cleared the Evening at 19:03" and the newer, unrelated edit silently
-- won: the Evening vanished from every later report.
--
-- This column is stamped ONLY when an edit actually carries an Evening value,
-- so the authority compares Evening edit against Evening edit. NULL therefore
-- means "the Evening on this row was never user-set", and such a row can no
-- longer out-vote a real Evening entered elsewhere today.
--
-- The one-time backfill stamps only rows that actually CARRY an Evening, using
-- the whole-row timestamp they are being compared on today. Rows with a blank
-- Evening are deliberately left NULL: pre-migration we cannot tell a deliberate
-- clear from an Evening that was simply never set there, and treating them as
-- clears would keep out-voting the authority and leave the Evenings this bug
-- already wiped lost for good. Left NULL they heal from the authority on the
-- next generation. The cost is that a genuine clear made before this migration
-- comes back once and has to be re-cleared, which then stamps correctly.
--
-- The backfill runs only when the column is actually added, so re-running this
-- migration can never stamp a row whose Evening was never edited.
--
-- Fully ADDITIVE: one new nullable column; no existing column is touched.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'daily_call_plan_report_rows'
      AND column_name = 'evening_rtpl_status_updated_at'
  ) THEN
    ALTER TABLE daily_call_plan_report_rows
      ADD COLUMN evening_rtpl_status_updated_at TIMESTAMPTZ;

    UPDATE daily_call_plan_report_rows
    SET evening_rtpl_status_updated_at = updated_at
    WHERE updated_at IS NOT NULL
      AND NULLIF(TRIM(COALESCE(evening_rtpl_status, '')), '') IS NOT NULL;
  END IF;
END $$;
