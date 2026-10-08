-- Which BOD/EOD row each RTPL status counts under, chosen by the admin on the
-- RTPL Statuses page. Before this the row was guessed from words in the status
-- name, so a new status usually counted under no row and a rename could move a
-- status into another row. See shared/src/constants/statusBuckets.ts.
--
-- Existing statuses are filled by applyRtplStatusBucketMigration.ts using the
-- old keyword rules (suggestStatusBucket), so the numbers do not move on day
-- one. NULL means "not chosen yet" and falls back to those rules.
ALTER TABLE rtpl_statuses ADD COLUMN IF NOT EXISTS bod_eod_bucket VARCHAR(32);
