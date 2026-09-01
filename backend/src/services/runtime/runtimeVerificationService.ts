import { query } from "../../config/database.js";

interface RequiredColumn {
  tableName: string;
  columnName: string;
}

interface InformationSchemaColumnRow {
  table_name: string;
  column_name: string;
}

export interface RuntimeVerificationResult {
  ok: boolean;
  checkedAt: string;
  missingTables: string[];
  missingColumns: RequiredColumn[];
  /**
   * Feature tables that are absent. The API still serves (`ok` stays true), but
   * the features backed by these tables will 500 until their migration is run.
   */
  missingFeatureTables: string[];
  /**
   * Feature COLUMNS that are absent from tables that do exist. Same contract as
   * missingFeatureTables — reported, but `ok` stays true.
   *
   * This list exists because of the 2026-08-06 outage: migration 040 adds
   * `evening_rtpl_status_updated_at`, the report-row repository selects it in
   * six places, and the column was missing on prod — so report history, report
   * generation and engineer productivity all answered 500 while this endpoint
   * cheerfully reported `ready` with nothing missing. A dropped column on an
   * existing table was the one shape the check could not see.
   */
  missingFeatureColumns: RequiredColumn[];
  /** True when the core schema is intact but a feature migration is unapplied. */
  degraded: boolean;
}

/**
 * Core schema. Without these the API cannot serve its primary flows, so their
 * absence flips `ok` to false — which makes `GET /health/runtime` answer 503 and,
 * in turn, fails the container healthcheck in docker-compose.yml.
 */
const REQUIRED_TABLES = [
  "source_upload_batches",
  "flex_wip_records",
  "renderways_records",
  "call_plan_records",
  "pincode_area_mappings",
  "sla_rules",
  "daily_call_plan_reports",
  "daily_call_plan_report_rows",
  "report_comparisons",
  "report_row_diffs",
] as const;

/**
 * Per-feature tables, each created by its own `migrate:*` script.
 *
 * These are reported but deliberately do NOT flip `ok`. The healthcheck in
 * docker-compose.yml treats a 503 from `/health/runtime` as an unhealthy
 * container, so gating readiness on them would mean that deploying code whose
 * migration has not been applied yet takes the whole API out of service —
 * turning one broken page into a full outage. Reporting without failing gives
 * the visibility (`missingFeatureTables`) without that footgun.
 *
 * Keep this list in step with backend/src/scripts/apply*Migration.ts.
 */
const FEATURE_TABLES = [
  "users",
  "regions",
  "report_history_sessions",
  "user_activity_log",
  "engineers",
  "rtpl_statuses",
  "user_record_layouts",
  "access_roles",
  "special_access",
  // migrate:warranty — the HP warranty lookup endpoints 500 without these.
  "hp_warranty_cache",
  "warranty_jobs",
  "warranty_job_items",
  // migrate:user-regions — multi-region admin assignment 500s without it.
  "user_regions",
  // migrate:special-access-edit — 026 table; 027's updated_by_special_access
  // column ships in the same script, and without it EVERY row-edit save 500s
  // (the shared UPDATE references the column), so this entry is the early
  // warning for both.
  "special_access_record_layouts",
  // migrate:closure-dates / migrate:customer-feedback — closure-date import
  // and per-case customer feedback 500 without these.
  "case_closure_dates",
  "case_customer_feedback",
  // migrate:parts-catalog — the Parts Catalog endpoints 500 without it.
  "parts_catalog",
  // migrate:quotations — the Quotations endpoints 500 without these.
  "quotations",
  "quotation_sequences",
  // migrate:region-eod — the Final-EOD endpoints 500 without these.
  "region_eod_state",
  "region_productivity_snapshot",
  // migrate:flex-raw — the raw-data import and its region-card counts 500 without it.
  "flex_raw_records",
  // migrate:vendor-access — the vendor portal + case assignment 500 without these.
  "vendor_access",
  "vendor_case_assignments",
  // migrate:geocoding / migrate:office-distance / migrate:office-address-distances.
  //
  // Report generation reads all five, and it runs on EVERY page load — so an
  // unapplied geo migration is not a broken corner of the app, it is the whole
  // dashboard. They were invisible here while the readers caught the missing-table
  // error, which looked tolerant and was not: the catch cannot un-abort the
  // transaction the read sits in, so generation died anyway with a 25P02 from some
  // later statement. The readers ask `to_regclass` now, but the deploy still needs to
  // be able to SEE that the migration is outstanding.
  "pincode_geo",
  "geocode_cache",
  "work_order_geocodes",
  "region_offices",
  "office_pincode_distances",
  "office_address_distances",
] as const;

const REQUIRED_COLUMNS: readonly RequiredColumn[] = [
  // migrate:user-sections. CORE on purpose: findActiveUserById selects it, so
  // without this column EVERY authenticated request 500s (the 2026-07-16
  // production outage) — the API genuinely cannot serve, and readiness should
  // say so instead of the app dying silently endpoint by endpoint.
  { tableName: "users", columnName: "accessible_sections" },
  { tableName: "source_upload_batches", columnName: "source_type" },
  { tableName: "source_upload_batches", columnName: "status" },
  { tableName: "source_upload_batches", columnName: "row_count" },
  { tableName: "source_upload_batches", columnName: "region_id" },
  { tableName: "flex_wip_records", columnName: "normalized_ticket_id" },
  { tableName: "flex_wip_records", columnName: "normalized_case_id" },
  { tableName: "flex_wip_records", columnName: "create_time" },
  { tableName: "flex_wip_records", columnName: "customer_pincode" },
  { tableName: "renderways_records", columnName: "normalized_ticket_id" },
  { tableName: "renderways_records", columnName: "normalized_case_id" },
  { tableName: "renderways_records", columnName: "partner_accept" },
  { tableName: "renderways_records", columnName: "rtpl_status" },
  { tableName: "call_plan_records", columnName: "normalized_ticket_id" },
  { tableName: "call_plan_records", columnName: "morning_status" },
  { tableName: "sla_rules", columnName: "wip_aging_category" },
  { tableName: "sla_rules", columnName: "sla_hours" },
  { tableName: "pincode_area_mappings", columnName: "pincode" },
  { tableName: "pincode_area_mappings", columnName: "area_name" },
  { tableName: "daily_call_plan_reports", columnName: "report_date" },
  { tableName: "daily_call_plan_report_rows", columnName: "match_status" },
  { tableName: "daily_call_plan_report_rows", columnName: "match_notes" },
  { tableName: "daily_call_plan_report_rows", columnName: "change_type" },
  { tableName: "daily_call_plan_report_rows", columnName: "changed_fields" },
  { tableName: "daily_call_plan_report_rows", columnName: "change_summary" },
  { tableName: "daily_call_plan_report_rows", columnName: "flex_status_unchanged_days" },
  { tableName: "daily_call_plan_report_rows", columnName: "carried_forward_fields" },
  { tableName: "daily_call_plan_report_rows", columnName: "manual_fields_completed" },
  { tableName: "daily_call_plan_report_rows", columnName: "manual_fields_missing" },
  { tableName: "daily_call_plan_report_rows", columnName: "product_line_name" },
  { tableName: "daily_call_plan_report_rows", columnName: "work_location" },
  { tableName: "daily_call_plan_report_rows", columnName: "remarks" },
  { tableName: "daily_call_plan_report_rows", columnName: "manual_notes" },
  { tableName: "daily_call_plan_report_rows", columnName: "updated_at" },
  { tableName: "daily_call_plan_report_rows", columnName: "updated_by" },
  { tableName: "report_comparisons", columnName: "current_session_id" },
  { tableName: "report_comparisons", columnName: "previous_session_id" },
  { tableName: "report_comparisons", columnName: "summary_json" },
  { tableName: "report_row_diffs", columnName: "ticket_id" },
  { tableName: "report_row_diffs", columnName: "change_type" },
  { tableName: "report_row_diffs", columnName: "changed_fields" },
  // migrate:flex-raw-month — the raw-data summary/sync 500 without source_month.
  { tableName: "flex_raw_records", columnName: "source_month" },
];

/**
 * Per-feature COLUMNS on tables that already exist. Reported without flipping
 * `ok`, for the same reason as FEATURE_TABLES: a 503 here fails the container
 * healthcheck, so gating on them would turn "one migration not yet run" into a
 * full outage.
 *
 * Keep this list in step with the migrations that ADD COLUMN to a live table —
 * those are invisible to the table-level checks above.
 */
const FEATURE_COLUMNS: readonly RequiredColumn[] = [
  // migrate:evening-status-edited-at (040). The report-row repository selects
  // this in six places, so report history, generation and productivity all 500
  // without it — the 2026-08-06 outage.
  {
    tableName: "daily_call_plan_report_rows",
    columnName: "evening_rtpl_status_updated_at",
  },
  // migrate:closure-status (041). The closure comparison/overlay reads these.
  { tableName: "case_closure_dates", columnName: "closed_on" },
  { tableName: "case_closure_dates", columnName: "closure_status" },
];

export async function verifyRuntimeSchema(): Promise<RuntimeVerificationResult> {
  const result = await query<InformationSchemaColumnRow>(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `,
    [[...REQUIRED_TABLES, ...FEATURE_TABLES]],
  );
  const tableNames = new Set(result.rows.map((row) => row.table_name));
  const columnKeys = new Set(
    result.rows.map((row) => `${row.table_name}.${row.column_name}`),
  );
  const missingTables = REQUIRED_TABLES.filter(
    (tableName) => !tableNames.has(tableName),
  );
  const missingColumns = REQUIRED_COLUMNS.filter((column) => {
    return !columnKeys.has(`${column.tableName}.${column.columnName}`);
  });
  const missingFeatureTables = FEATURE_TABLES.filter(
    (tableName) => !tableNames.has(tableName),
  );
  // Only meaningful for tables that exist: a column on an absent table is
  // already reported as a missing table, and listing it twice would read as two
  // separate problems.
  const missingFeatureColumns = FEATURE_COLUMNS.filter(
    (column) =>
      tableNames.has(column.tableName) &&
      !columnKeys.has(`${column.tableName}.${column.columnName}`),
  );

  const ok = missingTables.length === 0 && missingColumns.length === 0;

  return {
    ok,
    checkedAt: new Date().toISOString(),
    missingTables,
    missingColumns,
    missingFeatureTables: [...missingFeatureTables],
    missingFeatureColumns: [...missingFeatureColumns],
    degraded:
      ok && (missingFeatureTables.length > 0 || missingFeatureColumns.length > 0),
  };
}
