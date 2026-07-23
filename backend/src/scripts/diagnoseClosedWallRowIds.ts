// READ-ONLY diagnostic for the 2026-07-22 "everything is CLOSED + Save failed:
// row has not been persisted yet" incident.
//
// Prints, for the given report dates (default: today + yesterday, server time):
//   1. Every report + history session for those dates, with row counts, closed
//      counts and the size of the flex file each report was generated from —
//      including which session the app treats as "latest" (updated_at DESC).
//   2. Every recent FLEX_WIP upload batch with its stored row count — a sudden
//      drop exposes a partial/truncated file.
//   3. For each sample WO: its presence in each report's PERSISTED rows
//      (change_type / same_day_closed / is_excluded) and in each recent flex
//      upload file. A WO visible on screen but absent from a report's persisted
//      rows is exactly the un-savable id:null case.
//
// Usage (prod): node dist/scripts/diagnoseClosedWallRowIds.js [YYYY-MM-DD ...] [WO-xxxx ...]
//   Dates and WOs can be mixed in any order; sensible defaults otherwise.
import { closeDatabasePool, pool } from "../config/database.js";

const DEFAULT_WOS = [
  "WO-035223720",
  "WO-035204350",
  "WO-035221292",
  "WO-035219346",
  "WO-035215652",
];

function isoDate(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function parseArgs(argv: string[]): { dates: string[]; wos: string[] } {
  const dates: string[] = [];
  const wos: string[] = [];
  for (const arg of argv) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      dates.push(arg);
    } else if (arg.trim()) {
      wos.push(arg.trim());
    }
  }
  return {
    dates: dates.length > 0 ? dates : [isoDate(1), isoDate(0)],
    wos: wos.length > 0 ? wos : DEFAULT_WOS,
  };
}

async function run(): Promise<void> {
  const { dates, wos } = parseArgs(process.argv.slice(2));
  const client = await pool.connect();
  try {
    console.log("=== diagnoseClosedWallRowIds ===");
    console.log("dates:", dates.join(", "));
    console.log("sample WOs:", wos.join(", "));

    // 1. Reports + sessions per date.
    const reports = await client.query(
      `
        SELECT
          reports.report_date::TEXT              AS report_date,
          reports.id                             AS report_id,
          reports.created_at::TEXT               AS report_created_at,
          sessions.id                            AS session_id,
          sessions.status                        AS session_status,
          sessions.created_at::TEXT              AS session_created_at,
          sessions.updated_at::TEXT              AS session_updated_at,
          reports.flex_upload_batch_id           AS flex_batch,
          (SELECT COUNT(*) FROM daily_call_plan_report_rows r
            WHERE r.report_id = reports.id)      AS persisted_rows,
          (SELECT COUNT(*) FROM daily_call_plan_report_rows r
            WHERE r.report_id = reports.id
              AND r.change_type = 'CLOSED')      AS closed_rows,
          (SELECT COUNT(*) FROM daily_call_plan_report_rows r
            WHERE r.report_id = reports.id
              AND r.same_day_closed)             AS same_day_closed_rows,
          (SELECT COUNT(*) FROM daily_call_plan_report_rows r
            WHERE r.report_id = reports.id
              AND r.is_excluded)                 AS excluded_rows,
          (SELECT COUNT(*) FROM flex_wip_records f
            WHERE f.upload_batch_id = reports.flex_upload_batch_id) AS flex_file_rows
        FROM daily_call_plan_reports reports
        LEFT JOIN report_history_sessions sessions
          ON sessions.daily_call_plan_report_id = reports.id
        WHERE reports.report_date = ANY($1::date[])
        ORDER BY reports.report_date ASC, sessions.updated_at DESC NULLS LAST
      `,
      [dates],
    );
    console.log("\n--- 1. Reports & sessions (first row per date = what the app opens as 'latest') ---");
    console.table(reports.rows);

    // 2. Recent FLEX_WIP upload batches — spot a partial file by row_count.
    const batches = await client.query(
      `
        SELECT
          b.id,
          b.created_at::TEXT AS uploaded_at,
          b.original_file_name,
          b.status,
          b.row_count        AS declared_rows,
          b.error_count,
          b.region_id,
          COUNT(f.id)        AS stored_rows
        FROM source_upload_batches b
        LEFT JOIN flex_wip_records f ON f.upload_batch_id = b.id
        WHERE b.source_type = 'FLEX_WIP'
          AND b.created_at > NOW() - INTERVAL '4 days'
        GROUP BY b.id
        ORDER BY b.created_at DESC
      `,
    );
    console.log("\n--- 2. FLEX_WIP uploads, last 4 days (compare row counts between files) ---");
    console.table(batches.rows);

    // 3a. Sample WOs in persisted report rows.
    const reportRows = await client.query(
      `
        SELECT
          r.ticket_id,
          reports.report_date::TEXT AS report_date,
          r.report_id,
          r.serial_no,
          r.change_type,
          r.same_day_closed,
          r.is_excluded,
          r.rtpl_status             AS morning,
          r.evening_rtpl_status     AS evening,
          r.updated_at::TEXT        AS row_updated_at
        FROM daily_call_plan_report_rows r
        JOIN daily_call_plan_reports reports ON reports.id = r.report_id
        WHERE reports.report_date = ANY($1::date[])
          AND UPPER(TRIM(r.ticket_id)) = ANY($2::text[])
        ORDER BY r.ticket_id, reports.report_date, r.serial_no
      `,
      [dates, wos.map((wo) => wo.toUpperCase())],
    );
    console.log("\n--- 3a. Sample WOs in PERSISTED report rows (absent here + visible on screen = un-savable id:null row) ---");
    console.table(reportRows.rows);

    // 3b. Sample WOs in the uploaded flex files.
    const flexPresence = await client.query(
      `
        SELECT
          f.ticket_id,
          b.created_at::TEXT AS uploaded_at,
          b.original_file_name,
          f.upload_batch_id
        FROM flex_wip_records f
        JOIN source_upload_batches b ON b.id = f.upload_batch_id
        WHERE b.created_at > NOW() - INTERVAL '4 days'
          AND (UPPER(TRIM(f.ticket_id)) = ANY($1::text[])
            OR UPPER(TRIM(f.normalized_ticket_id)) = ANY($1::text[]))
        ORDER BY f.ticket_id, b.created_at DESC
      `,
      [wos.map((wo) => wo.toUpperCase())],
    );
    console.log("\n--- 3b. Sample WOs in uploaded FLEX files (absent from the newest file = auto-closed) ---");
    console.table(flexPresence.rows);

    console.log("\nHow to read this:");
    console.log("- 3a shows a WO for an older report but NOT for the report you have open -> the row is injected at view time with no id; that's the save failure.");
    console.log("- 3b shows the WO in older files but NOT the newest -> the closure is real per the file; if the WO is still open in HP Flex, the newest file was partial -> re-upload the full file.");
    console.log("- In 2, a newest batch with far fewer stored_rows than the previous ones = partial/truncated upload.");
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
