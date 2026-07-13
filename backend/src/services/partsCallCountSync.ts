import type { GeneratedDailyCallPlanReport } from "../types/reportGeneration.js";
import {
  mapAspCodeToRegion,
  inventoryFetch,
  inventoryApiConfigured,
} from "./inventorySyncService.js";

/**
 * Region-wise "Active Part Cases" count — exactly what the OpenCall Overview and the
 * record table show: active rows (no closed-synthetic, no Request-to-Cancel) whose PART
 * field is non-blank. Computed from the already-generated report (never re-generates),
 * then pushed to the inventory system so HP Stock can display it.
 */

export interface PartsCallCountRow {
  report_date: string;
  region: string;
  count: number;
}

function isRequestToCancel(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase() === "request to cancel";
}

export function computePartsCallCounts(
  report: GeneratedDailyCallPlanReport,
): PartsCallCountRow[] {
  const byRegion = new Map<string, number>();

  for (const row of report.rows) {
    // isTodayCallPlanVisibleRow: drop closed-synthetic and Request-to-Cancel rows.
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

  const reportDate = report.reportDate || "";
  return Array.from(byRegion.entries())
    .map(([region, count]) => ({ report_date: reportDate, region, count }))
    .sort((a, b) => a.region.localeCompare(b.region));
}

// The frontend polls report generation every ~10s; skip the write when nothing changed.
let lastPushedFingerprint = "";

export async function pushPartsCallCounts(
  rows: PartsCallCountRow[],
  force = false,
): Promise<void> {
  if (rows.length === 0) return;

  const fingerprint = JSON.stringify(rows);
  if (!force && fingerprint === lastPushedFingerprint) {
    return; // unchanged since the last push — nothing to do
  }

  if (inventoryApiConfigured()) {
    const res = await inventoryFetch("/hp-stock/parts-call-counts/bulk_upsert/", {
      method: "POST",
      body: JSON.stringify(rows),
    });
    if (!res.ok) {
      throw new Error(`bulk_upsert failed (${res.status}): ${await res.text()}`);
    }
  } else {
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
    } finally {
      db.close();
    }
  }

  lastPushedFingerprint = fingerprint;
  const total = rows.reduce((s, r) => s + r.count, 0);
  console.info(
    `[PartsCallCounts] Synced ${rows[0]?.report_date} — Active Part Cases: ${total} (${rows
      .map((r) => `${r.region} ${r.count}`)
      .join(", ")})`,
  );
}

/**
 * Fire-and-forget from the report-generation flow. Never throws and never blocks the
 * response — a failure here must not affect report generation.
 */
export function syncPartsCallCountsFromReport(
  report: GeneratedDailyCallPlanReport,
): void {
  try {
    const rows = computePartsCallCounts(report);
    void pushPartsCallCounts(rows).catch((error: unknown) => {
      console.error("[PartsCallCounts] push failed:", error);
    });
  } catch (error) {
    console.error("[PartsCallCounts] compute failed:", error);
  }
}
