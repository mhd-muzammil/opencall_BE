-- Per-user operational section access for REGION_ADMIN logins.
--
-- Opt-OUT model: NULL means "all sections" (the previous behaviour), so every existing
-- user keeps seeing everything until an admin explicitly narrows them. A non-null array
-- lists exactly the sections that user may see. SUPER_ADMIN ignores this column entirely
-- (they always see everything).
--
-- Fully ADDITIVE: nothing else in `users` is touched. A NULL default means no backfill is
-- needed and no current REGION_ADMIN loses any access.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS accessible_sections TEXT[];
