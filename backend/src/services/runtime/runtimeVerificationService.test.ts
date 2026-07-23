import { describe, expect, it, vi } from "vitest";
import { verifyRuntimeSchema } from "./runtimeVerificationService.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("../../config/database.js", () => ({
  query: mocks.query,
}));

const CORE_TABLES = [
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
];

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
  "hp_warranty_cache",
  "warranty_jobs",
  "warranty_job_items",
  "user_regions",
  "special_access_record_layouts",
  "case_closure_dates",
  "case_customer_feedback",
  "parts_catalog",
  "quotations",
  "quotation_sequences",
  "region_eod_state",
  "region_productivity_snapshot",
  "flex_raw_records",
];

const REQUIRED_COLUMNS: Record<string, string[]> = {
  users: ["accessible_sections"],
  source_upload_batches: ["source_type", "status", "row_count", "region_id"],
  flex_wip_records: [
    "normalized_ticket_id",
    "normalized_case_id",
    "create_time",
    "customer_pincode",
  ],
  renderways_records: [
    "normalized_ticket_id",
    "normalized_case_id",
    "partner_accept",
    "rtpl_status",
  ],
  call_plan_records: ["normalized_ticket_id", "morning_status"],
  sla_rules: ["wip_aging_category", "sla_hours"],
  pincode_area_mappings: ["pincode", "area_name"],
  daily_call_plan_reports: ["report_date"],
  daily_call_plan_report_rows: [
    "match_status",
    "match_notes",
    "change_type",
    "changed_fields",
    "change_summary",
    "flex_status_unchanged_days",
    "carried_forward_fields",
    "manual_fields_completed",
    "manual_fields_missing",
    "product_line_name",
    "work_location",
    "remarks",
    "manual_notes",
    "updated_at",
    "updated_by",
  ],
  report_comparisons: ["current_session_id", "previous_session_id", "summary_json"],
  report_row_diffs: ["ticket_id", "change_type", "changed_fields"],
  flex_raw_records: ["source_month"],
};

/** Rows as information_schema would return them for the given tables. */
function schemaRows(tables: readonly string[]) {
  return tables.flatMap((table) => {
    const columns = REQUIRED_COLUMNS[table] ?? ["id"];
    return columns.map((column) => ({ table_name: table, column_name: column }));
  });
}

describe("verifyRuntimeSchema", () => {
  it("is ready when the whole schema is present", async () => {
    mocks.query.mockResolvedValue({
      rows: schemaRows([...CORE_TABLES, ...FEATURE_TABLES]),
    });

    const result = await verifyRuntimeSchema();

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.missingTables).toEqual([]);
    expect(result.missingFeatureTables).toEqual([]);
  });

  /**
   * The safety property. `/health/runtime` answers 503 when `ok` is false, and
   * docker-compose uses that endpoint as the API container's healthcheck — so a
   * missing feature table must never flip `ok`, or deploying code ahead of its
   * migration would take the entire API out of service.
   */
  it("reports a missing feature table as degraded WITHOUT failing readiness", async () => {
    const present = [...CORE_TABLES, ...FEATURE_TABLES].filter(
      (table) => table !== "access_roles" && table !== "special_access",
    );
    mocks.query.mockResolvedValue({ rows: schemaRows(present) });

    const result = await verifyRuntimeSchema();

    // This is what a production box with an unapplied 023_special_access looks like.
    expect(result.missingFeatureTables).toEqual(["access_roles", "special_access"]);
    expect(result.degraded).toBe(true);
    // Crucially: still ready → still 200 → healthcheck stays green.
    expect(result.ok).toBe(true);
    expect(result.missingTables).toEqual([]);
  });

  it("is not ready when a core table is missing", async () => {
    const present = [...CORE_TABLES, ...FEATURE_TABLES].filter(
      (table) => table !== "sla_rules",
    );
    mocks.query.mockResolvedValue({ rows: schemaRows(present) });

    const result = await verifyRuntimeSchema();

    expect(result.ok).toBe(false);
    expect(result.missingTables).toEqual(["sla_rules"]);
    // `degraded` is only meaningful while the core schema is intact.
    expect(result.degraded).toBe(false);
  });

  it("is not ready when a core column is missing", async () => {
    const rows = schemaRows([...CORE_TABLES, ...FEATURE_TABLES]).filter(
      (row) =>
        !(row.table_name === "daily_call_plan_reports" && row.column_name === "report_date"),
    );
    mocks.query.mockResolvedValue({ rows });

    const result = await verifyRuntimeSchema();

    expect(result.ok).toBe(false);
    expect(result.missingColumns).toEqual([
      { tableName: "daily_call_plan_reports", columnName: "report_date" },
    ]);
  });
});
