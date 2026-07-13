import { closeDatabasePool } from "../config/database.js";
import { generateDailyCallPlanReport } from "../services/callPlanGenerator/dailyCallPlanGenerator.js";
import { findLatestCompletedReportSession } from "../repositories/historyRepository.js";
import {
  mapAspCodeToRegion,
  inventoryFetch,
  inventoryApiConfigured,
} from "../services/inventorySyncService.js";

// Region-wise "Active Part Cases" count, computed from the SAME generated report the
// OpenCall UI shows (not from the persisted rows — the generator re-derives PART, so a
// raw DB count does not match). Applies exactly the OpenCall Overview / record-table
// rules: active rows (no closed-synthetic, no Request-to-Cancel) whose PART is non-blank.

interface CountRow {
  report_date: string;
  region: string;
  count: number;
}

function isRequestToCancel(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase() === "request to cancel";
}

async function computeCounts(): Promise<CountRow[]> {
  const session = await findLatestCompletedReportSession();
  if (!session?.flex_upload_batch_id) {
    console.warn("[PartsCallCounts] No completed report session found");
    return [];
  }

  const report = await generateDailyCallPlanReport({
    reportDate: session.report_date ?? "",
    generatedBy: session.user_id,
    regionId: null,
    flexUploadBatchId: session.flex_upload_batch_id,
    renderwaysUploadBatchId: session.renderways_upload_batch_id,
    callPlanUploadBatchId: session.call_plan_upload_batch_id,
    allowCreate: false,
  });

  const byRegion = new Map<string, number>();
  for (const row of report.rows) {
    // isTodayCallPlanVisibleRow: exclude closed-synthetic and Request-to-Cancel rows.
    if (row.carryForward.closedSyntheticRow) continue;
    const output = row.output as unknown as Record<string, unknown>;
    if (
      isRequestToCancel(output["Flex Status"]) ||
      isRequestToCancel(row.comparison?.previousFlexStatus)
    ) {
      continue;
    }
    // PART filter with (BLANK) unchecked.
    if (String(output["Part"] ?? "").trim() === "") continue;

    const region = mapAspCodeToRegion(String(output["Work Location"] ?? ""));
    if (!region) continue;
    byRegion.set(region, (byRegion.get(region) ?? 0) + 1);
  }

  const reportDate = report.reportDate || session.report_date || "";
  const rows = Array.from(byRegion.entries()).map(([region, count]) => ({
    report_date: reportDate,
    region,
    count,
  }));
  const total = rows.reduce((s, r) => s + r.count, 0);
  console.info(
    `[PartsCallCounts] ${reportDate} — Active Part Cases: ${total} (${rows
      .map((r) => `${r.region} ${r.count}`)
      .join(", ")})`,
  );
  return rows;
}

async function pushViaApi(rows: CountRow[]): Promise<void> {
  const res = await inventoryFetch("/hp-stock/parts-call-counts/bulk_upsert/", {
    method: "POST",
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    throw new Error(`bulk_upsert failed (${res.status}): ${await res.text()}`);
  }
  console.info(`[PartsCallCounts] Pushed ${rows.length} rows via API`);
}

async function pushViaSqlite(rows: CountRow[]): Promise<void> {
  const dbPath =
    process.env.INVENTORY_DB_PATH ||
    "c:/Users/mohamed vaseem/Documents/company ptoject/inventry-web/inventory_backend/db.sqlite3";
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO hp_stock_opencallpartscount (report_date, region, count, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(report_date, region)
      DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at
    `);
    for (const r of rows) {
      stmt.run(r.report_date, r.region, r.count, now);
    }
    console.info(`[PartsCallCounts] Wrote ${rows.length} rows to inventory SQLite`);
  } finally {
    db.close();
  }
}

async function run(): Promise<void> {
  const rows = await computeCounts();
  if (rows.length === 0) return;
  if (inventoryApiConfigured()) {
    await pushViaApi(rows);
  } else {
    await pushViaSqlite(rows);
  }
}

run()
  .catch((error: unknown) => {
    console.error("[PartsCallCounts] Failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabasePool();
  });
