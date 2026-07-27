#!/usr/bin/env node
// Standalone prod copy of src/scripts/diagnoseMissingRecordCalls.ts.
// Runs with plain `node` from /app (uses /app/node_modules/pg) — no build step.
// Paste onto the server and run: node diagMissingCalls.js [flex-batch-id] [report-id]
// No args = newest FLEX_WIP batch and the report generated from it.
const fs = require("fs");
const path = require("path");

if (!process.env.DATABASE_URL) {
  for (const envPath of [".env", path.join(__dirname, ".env")]) {
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
    break;
  }
}

const { Pool } = require("pg");

const ASP_CODE_REGION_MAP = {
  ASPS01461: "CHENNAI",
  ASPS01463: "VELLORE",
  ASPS01465: "SALEM",
  ASPS01489: "KANCHIPURAM",
  ASPS01511: "HOSUR",
};

function aspCodesForRegionIdentity(regionCode, regionName) {
  const wanted = new Set();
  const codeUpper = String(regionCode ?? "").trim().toUpperCase();
  const nameUpper = String(regionName ?? "").trim().toUpperCase();
  if (codeUpper) wanted.add(codeUpper);
  for (const [aspCode, mappedName] of Object.entries(ASP_CODE_REGION_MAP)) {
    const canonical = mappedName.trim().toUpperCase();
    if (canonical === nameUpper || canonical === codeUpper) {
      wanted.add(aspCode.toUpperCase());
    }
  }
  return wanted;
}

// Mirrors normalizeTicketId + normalizeTicketKey from the backend exactly.
function normalizeTicketKey(value) {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase()
    .replace(/[\s_-]+/g, "")
    .replace(/[^A-Z0-9]/g, "");
  if (/^\d+$/.test(cleaned)) return cleaned.replace(/^0+(?=\d)/, "");
  const wo = /^WO0*(\d+)$/.exec(cleaned);
  if (wo) return wo[1].replace(/^0+(?=\d)/, "");
  return cleaned;
}

function isRequestToCancel(value) {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ") === "request to cancel"
  );
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set and no .env found");
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined,
  });
  const args = process.argv.slice(2).filter((arg) => UUID_PATTERN.test(arg));
  const client = await pool.connect();
  try {
    console.log("=== diagnoseMissingRecordCalls (standalone) ===");

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

    const parseIssues = Array.isArray(batch.errors) ? batch.errors : [];
    const rowParseIssues = parseIssues.filter((i) => i && i.type === "ROW_PARSE_ISSUE");
    if (rowParseIssues.length > 0) {
      console.log(`\n!! ${rowParseIssues.length} file row(s) were skipped at parse time (never stored):`);
      console.table(rowParseIssues.slice(0, 20));
    }

    let batchScope = null;
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
    const reportId = reportsResult.rows[0].id;

    const flexRows = await client.query(
      `SELECT ticket_id, work_location, flex_status, create_time::TEXT
         FROM flex_wip_records WHERE upload_batch_id = $1`,
      [batch.id],
    );
    const flexByKey = new Map();
    for (const row of flexRows.rows) {
      const key = normalizeTicketKey(row.ticket_id);
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
    const reportByKey = new Map();
    for (const row of reportRows.rows) {
      const key = normalizeTicketKey(row.ticket_id);
      if (!key) continue;
      reportByKey.set(key, row);
    }

    console.log(`\nFile rows stored: ${flexRows.rows.length}  |  distinct work orders: ${flexByKey.size}  |  report rows: ${reportRows.rows.length}`);
    console.log("(file rows > work orders is normal: the flex export is one-row-per-part)");

    const missing = [];
    const hidden = [];
    for (const [key, flex] of flexByKey) {
      const reportRow = reportByKey.get(key);

      if (!reportRow) {
        let reason;
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

      if (reportRow.is_excluded) {
        hidden.push({ ticket: flex.ticketId, serial: reportRow.serial_no, why: "is_excluded=true (manually excluded row)" });
      } else if (reportRow.change_type === "CLOSED" && !reportRow.same_day_closed) {
        hidden.push({ ticket: flex.ticketId, serial: reportRow.serial_no, why: "closed synthetic row (visible only in Closed view)" });
      } else if (
        isRequestToCancel(reportRow.flex_status) ||
        isRequestToCancel(reportRow.previous_flex_status)
      ) {
        hidden.push({
          ticket: flex.ticketId,
          serial: reportRow.serial_no,
          why: `Request-to-Cancel filter hides it on Records (flex_status=${reportRow.flex_status}, previous=${reportRow.previous_flex_status})`,
        });
      }
    }

    console.log(`\n--- ${missing.length} ticket(s) in the file but NOT in the report ---`);
    if (missing.length > 0) console.table(missing);

    console.log(`\n--- ${hidden.length} ticket(s) in the report but HIDDEN on the Records page ---`);
    if (hidden.length > 0) console.table(hidden);

    if (missing.length === 0 && hidden.length === 0 && rowParseIssues.length === 0) {
      console.log("\nEvery ticket in the file is in the report and visible on Records.");
      console.log("If a call still looks missing, check: (a) the Records page is showing THIS report (session picker), (b) an active category/region filter, (c) the viewing user's region access (region admins only see their regions' ASP codes; blank Work Location rows are invisible to them).");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
