// READ-ONLY diagnostic: "I uploaded a flex file but some calls don't show on
// the Records page."
//
// Compares the tickets in a FLEX_WIP upload batch against the persisted rows
// of the report generated from it, and classifies every ticket that is either
// absent from the report or present-but-hidden on the Records page:
//
//   MISSING_FROM_REPORT  – dropped at generation. Sub-reason:
//     * blank Work Location under a region-scoped generation
//     * Work Location outside the batch region's ASP scope
//     * Work Location not in ASP_CODE_REGION_MAP at all (dropped whenever
//       generation or the viewing user is region-scoped)
//   EXCLUDED             – persisted with is_excluded (hidden everywhere)
//   CLOSED_SYNTHETIC     – change_type=CLOSED, not same-day (Closed view only)
//   HIDDEN_RTC           – Flex Status (or previous) = "Request to Cancel";
//                          the row is in the report but the Records page
//                          filters it out client-side
//
// Also prints file-row vs distinct-work-order counts: the flex export is
// one-row-per-part, so "598 rows in the file, 519 on Records" is usually the
// multi-part collapse, not missing calls.
//
// Usage (local): pnpm tsx src/scripts/diagnoseMissingRecordCalls.ts [batch-id] [report-id]
// Usage (prod):  node dist/scripts/diagnoseMissingRecordCalls.js [batch-id] [report-id]
//   No args = newest FLEX_WIP batch and the report(s) generated from it.
import { ASP_CODE_REGION_MAP, aspCodesForRegionIdentity } from "@opencall/shared";
import { closeDatabasePool, pool } from "../config/database.js";
import { getNormalizedTicketKey } from "../services/normalization/dedupeRowsByTicket.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRequestToCancel(value: unknown): boolean {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ") === "request to cancel"
  );
}

interface FlexTicket {
  ticketId: string;
  workLocation: string;
  flexStatus: string | null;
  createTime: string | null;
  fileRowCount: number;
}

interface ReportRowInfo {
  serialNo: number;
  changeType: string | null;
  sameDayClosed: boolean;
  isExcluded: boolean;
  flexStatus: string | null;
  previousFlexStatus: string | null;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => UUID_PATTERN.test(arg));
  const client = await pool.connect();
  try {
    console.log("=== diagnoseMissingRecordCalls ===");

    const batchResult = await client.query(
      args[0]
        ? `SELECT id, original_file_name, region_id, row_count, error_count, errors, created_at::TEXT
             FROM source_upload_batches WHERE id = $1 AND source_type = 'FLEX_WIP'`
        : `SELECT id, original_file_name, region_id, row_count, error_count, errors, created_at::TEXT
             FROM source_upload_batches WHERE source_type = 'FLEX_WIP'
             ORDER BY created_at DESC LIMIT 1`,
      args[0] ? [args[0]] : [],
    );
    const batch = batchResult.rows[0];
    if (!batch) {
      console.error("No FLEX_WIP upload batch found.");
      return;
    }
    console.log("\n--- Flex batch ---");
    console.table([{
      id: batch.id,
      file: batch.original_file_name,
      uploaded_at: batch.created_at,
      region_id: batch.region_id ?? "(none — unscoped)",
      declared_rows: batch.row_count,
      error_count: batch.error_count,
    }]);

    // Parse issues recorded on the batch (rows the parser skipped, e.g. no
    // Ticket ID). These calls never reach the DB at all.
    const parseIssues: unknown[] = Array.isArray(batch.errors) ? batch.errors : [];
    const rowParseIssues = parseIssues.filter(
      (issue) => (issue as { type?: string }).type === "ROW_PARSE_ISSUE",
    );
    if (rowParseIssues.length > 0) {
      console.log(`\n!! ${rowParseIssues.length} file row(s) were skipped at parse time (never stored):`);
      console.table(rowParseIssues.slice(0, 20));
    }

    // Region scope the batch imposes on every generation made from it.
    let batchScope: Set<string> | null = null;
    let batchRegionLabel = "(unscoped)";
    if (batch.region_id) {
      const regionResult = await client.query(
        `SELECT code, name FROM regions WHERE id = $1`,
        [batch.region_id],
      );
      const region = regionResult.rows[0];
      if (region) {
        batchScope = aspCodesForRegionIdentity(region.code, region.name);
        batchRegionLabel = `${region.name} [${region.code}] -> ASP scope {${[...batchScope].join(", ")}}`;
      }
    }
    console.log("Batch region scope:", batchRegionLabel);

    // Reports generated from this batch.
    const reportsResult = await client.query(
      args[1]
        ? `SELECT id, report_date::TEXT AS report_date, created_at::TEXT
             FROM daily_call_plan_reports WHERE id = $1`
        : `SELECT id, report_date::TEXT AS report_date, created_at::TEXT
             FROM daily_call_plan_reports WHERE flex_upload_batch_id = $1
             ORDER BY created_at DESC`,
      [args[1] ?? batch.id],
    );
    if (reportsResult.rows.length === 0) {
      console.error("No report was generated from this batch — that alone explains missing calls.");
      return;
    }
    console.log("\n--- Report(s) generated from this batch (diagnosing the newest) ---");
    console.table(reportsResult.rows);
    const reportId: string = reportsResult.rows[0].id;

    // Flex tickets, collapsed to one entry per work order (the file is
    // one-row-per-part; the report is one-row-per-work-order).
    const flexRows = await client.query(
      `SELECT ticket_id, work_location, flex_status, create_time::TEXT
         FROM flex_wip_records WHERE upload_batch_id = $1`,
      [batch.id],
    );
    const flexByKey = new Map<string, FlexTicket>();
    for (const row of flexRows.rows) {
      const key = getNormalizedTicketKey(row.ticket_id);
      if (!key) continue;
      const existing = flexByKey.get(key);
      if (existing) {
        existing.fileRowCount += 1;
      } else {
        flexByKey.set(key, {
          ticketId: row.ticket_id,
          workLocation: String(row.work_location ?? "").trim().toUpperCase(),
          flexStatus: row.flex_status,
          createTime: row.create_time,
          fileRowCount: 1,
        });
      }
    }

    const reportRows = await client.query(
      `SELECT ticket_id, serial_no, change_type, same_day_closed, is_excluded,
              flex_status, previous_flex_status
         FROM daily_call_plan_report_rows WHERE report_id = $1`,
      [reportId],
    );
    const reportByKey = new Map<string, ReportRowInfo>();
    for (const row of reportRows.rows) {
      const key = getNormalizedTicketKey(row.ticket_id);
      if (!key) continue;
      reportByKey.set(key, {
        serialNo: row.serial_no,
        changeType: row.change_type,
        sameDayClosed: row.same_day_closed,
        isExcluded: row.is_excluded,
        flexStatus: row.flex_status,
        previousFlexStatus: row.previous_flex_status,
      });
    }

    console.log(`\nFile rows stored: ${flexRows.rows.length}  |  distinct work orders: ${flexByKey.size}  |  report rows: ${reportRows.rows.length}`);
    console.log("(file rows > work orders is normal: the flex export is one-row-per-part)");

    const missing: Array<Record<string, unknown>> = [];
    const hidden: Array<Record<string, unknown>> = [];
    for (const [key, flex] of flexByKey) {
      const reportRow = reportByKey.get(key);

      if (!reportRow) {
        let reason: string;
        if (!flex.workLocation) {
          reason = "blank Work Location (dropped by any region-scoped generation)";
        } else if (batchScope && !batchScope.has(flex.workLocation)) {
          reason = `Work Location ${flex.workLocation} outside batch region scope`;
        } else if (!ASP_CODE_REGION_MAP[flex.workLocation]) {
          reason = `Work Location ${flex.workLocation} not in ASP_CODE_REGION_MAP (dropped when generation/view is region-scoped)`;
        } else {
          reason = "UNEXPLAINED — not a scope drop; check generation logs";
        }
        missing.push({
          ticket: flex.ticketId,
          work_location: flex.workLocation || "(blank)",
          flex_status: flex.flexStatus,
          create_time: flex.createTime,
          reason,
        });
        continue;
      }

      if (reportRow.isExcluded) {
        hidden.push({ ticket: flex.ticketId, serial: reportRow.serialNo, why: "is_excluded=true (manually excluded row)" });
      } else if (reportRow.changeType === "CLOSED" && !reportRow.sameDayClosed) {
        hidden.push({ ticket: flex.ticketId, serial: reportRow.serialNo, why: "closed synthetic row (visible only in Closed view)" });
      } else if (
        isRequestToCancel(reportRow.flexStatus) ||
        isRequestToCancel(reportRow.previousFlexStatus)
      ) {
        hidden.push({
          ticket: flex.ticketId,
          serial: reportRow.serialNo,
          why: `Request-to-Cancel filter hides it on Records (flex_status=${reportRow.flexStatus}, previous=${reportRow.previousFlexStatus})`,
        });
      }
    }

    console.log(`\n--- ${missing.length} ticket(s) in the file but NOT in the report ---`);
    if (missing.length > 0) console.table(missing);

    console.log(`\n--- ${hidden.length} ticket(s) in the report but HIDDEN on the Records page ---`);
    if (hidden.length > 0) console.table(hidden);

    if (missing.length === 0 && hidden.length === 0 && rowParseIssues.length === 0) {
      console.log("\nEvery ticket in the file is in the report and visible on Records.");
      console.log("If a call still looks missing, check: (a) the Records page is showing THIS report (top-right session picker), (b) an active category/region filter, (c) the viewing user's region access (region admins only see their regions' ASP codes; blank Work Location rows are invisible to them).");
    }
  } finally {
    client.release();
  }
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabasePool();
  });
