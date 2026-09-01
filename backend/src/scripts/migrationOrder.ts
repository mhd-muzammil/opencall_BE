// The order every migration script must run in, oldest first.
//
// Kept as data (no side effects) so both the runner and its test can import it —
// each apply*Migration script self-executes on import, so the list cannot live
// inside the runner without the test triggering 33 migrations.
//
// Order matters where a migration references an earlier one's table:
// regions are seeded (015) before engineers FK to them (017), users exist (013)
// before renewal_leads FKs to them, and special-access row editing (026/027)
// follows the special-access tables (023).
//
// A migration whose change is already applied is a no-op: every script guards
// with IF NOT EXISTS or an information_schema check, which is what makes
// running the whole list on every deploy safe.
//
// ADDING A MIGRATION: append it here. migrationOrder.test.ts fails if any
// apply*Migration script in this directory is missing from the list, so a new
// migration cannot silently skip the deploy.
export const MIGRATION_SCRIPTS: readonly string[] = [
  "applyComparisonMigration", // 005 day-over-day report comparison
  "applyManualCarryForwardMigration", // 007 manual field carry-forward metadata
  "applyReportRowEditMigration", // 008 persisted report row edits
  "applyUserManagementMigration", // 013 user management columns
  "applyActivityLogMigration", // 014 user activity log
  "applyRequiredRegionSeedMigration", // 015 required region seed
  "applyEngineersMigration", // 017 engineers (FKs regions -> after 015)
  "applyStatusAgingMigration", // 018 status aging
  "applyFlexStatusUnchangedDaysMigration", // 019 flex status unchanged days
  "applyRtplStatusesMigration", // 020 rtpl statuses
  "applyEveningStatusMigration", // 021 evening rtpl status
  "applyRecordLayoutsMigration", // 022 user record layouts
  "applySpecialAccessMigration", // 023 special access
  "applyWarrantyMigration", // 023 hp warranty lookup
  "applySameDayClosedMigration", // 024 same-day closed calls
  "applyUserRegionsMigration", // 025 user regions
  "applySpecialAccessEditMigration", // 026 + 027 (after 023)
  "applyUserSectionsMigration", // 028 user accessible sections
  "applyCaseClosureDatesMigration", // 029 case closure dates
  "applyCustomerFeedbackMigration", // 030 case customer feedback
  "applyCustomerFeedbackStructuredMigration", // 031 structured feedback
  "applyPartsCatalogMigration", // 032 parts catalog
  "applyQuotationsMigration", // 033 quotations
  "applyRegionEodMigration", // 034 region EOD
  "applyEngineerHpVendorIdsMigration", // 035 engineer HP/vendor ids
  "applyFlexRawRecordsMigration", // 036 flex raw records
  "applyFlexRawMonthMigration", // 037 flex raw month
  "applyVendorAccessMigration", // 038 vendor access
  "applyEngineerDeletedEventMigration", // 039 engineer deleted event
  "applyRenewalLeadsMigration", // 039 renewal leads (FKs users -> after 013)
  "applyEveningStatusEditTimestampMigration", // 040 evening status edited-at
  "applyClosureReportStatusMigration", // 041 closure report status
  "applyClosureSyncRunsMigration", // 042 closure sync runs
  "applyOfficeDistanceMigration", // 043 office distance (region_offices, pincode_geo)
  "applyCustomerAddressMigration", // 044 flex_wip_records address columns
  "applyWorkOrderGeocodingMigration", // 045 geocode_cache + work_order_geocodes
  "applyInboundEmailMigration", // 047 customer email ingest (own tables, no FKs)
  "applyInboundEmailBodyMigration", // 048 full body for the reading pane
  "applyInboundEmailEscalationMigration", // 049 escalation flag
  "applyEmailRepliesMigration", // 050 replies (FKs inbound_emails + users)
  "applyInboundEmailHtmlMigration", // 051 body_html + inline/attached files
  "applyOutboundEmailsMigration", // 052 compose (FKs inbound_emails + users)
  "applyQuotationLineItemsMigration", // 053 several line items per quotation (FK quotations)
  "applyManuallyClearedFieldsMigration", // 046 deliberately-cleared manual fields (free slot; runs last, plain ALTER)
  "applyRegionOfficesSeedMigration", // 054 the four remaining branch offices (region_offices -> after 043)
  "applyOfficeAddressDistancesMigration", // 055 office->address road routes (FKs geocode_cache -> after 045)
  "applyFlexRawClosedOnMigration", // 056 WO Closed date on raw records (flex_raw_records -> after 036)
  "applyInboundEmailMatchIndexesMigration", // 057 expression indexes for the email ingest's WO/sender lookups
  "applyInboundEmailMatchIndexesOrderedMigration", // 058 same indexes carrying id, so ORDER BY id DESC LIMIT 1 is served
  "applyInboundEmailMatchIndexesPlainMigration", // 059 rebuilds 058 plainly — the concurrent build never finished
  "applyQuotationEditAuditMigration", // 060 who last edited a quotation, and when
  "applyQuotationDeliveryMigration", // 061 quotation send + payment tracking
  "applyQuotationPaymentWatchMigration", // 062 what the reply said, and who acted on it
  "applyQuotationSendVerificationMigration", // 063 when the Sent folder was last asked
  "applyFieldezSlaMigration", // 064 FieldEZ's SLA for each open call
  "applyClosureCaseIdMultiWoMigration", // 065 a Case Id may carry several work orders
  "applyFlexWipLatestPerTicketMigration", // 066 newest flex record per ticket, for the Payroll sync
];

/**
 * Scripts that read their SQL from `infra/postgres/migrations` at runtime.
 *
 * The deploy image does not contain that directory — the Dockerfile copies only
 * `shared` and `backend` — so these cannot run inside the container. The runner
 * skips them when the SQL is not on disk.
 *
 * Skipping is safe rather than a gamble: these are the bootstrap migrations
 * (005-015) creating report_comparisons, users, regions and the activity log,
 * and every one of those tables is in the healthcheck's REQUIRED_TABLES. An API
 * answering /health/runtime with ok:true therefore has them by definition, so a
 * running box has already applied them. They still run in development, where
 * the repo — and so the SQL — is present.
 */
export const MIGRATIONS_NEEDING_REPO_SQL: ReadonlySet<string> = new Set([
  "applyComparisonMigration",
  "applyManualCarryForwardMigration",
  "applyReportRowEditMigration",
  "applyUserManagementMigration",
  "applyActivityLogMigration",
  "applyRequiredRegionSeedMigration",
]);
