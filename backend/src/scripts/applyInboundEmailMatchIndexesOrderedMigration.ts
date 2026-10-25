// Migration 058_inbound_email_match_indexes_ordered.sql — deliberately a no-op in the deploy runner.
//
// It built its indexes with CREATE INDEX CONCURRENTLY, and on a live box that build waits
// for every query already running against daily_call_plan_report_rows. The dashboard keeps
// that table busy, so the build never got through: the deploy of 2026-10-25 sat on it for
// minutes with the migration runner stuck behind it. 059 replaced these indexes with a plain
// build anyway, and drops whatever this one left behind (an interrupted concurrent build
// leaves an INVALID index) — so the end state is the same without it. Kept as a file so the
// migration order, and its test, still list it.
console.log("Skipped migration 058_inbound_email_match_indexes_ordered.sql — superseded by 059 (plain index build)");
