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

  const ok = missingTables.length === 0 && missingColumns.length === 0;

  return {
    ok,
    checkedAt: new Date().toISOString(),
    missingTables,
    missingColumns,
    missingFeatureTables: [...missingFeatureTables],
    degraded: ok && missingFeatureTables.length > 0,
  };
}
