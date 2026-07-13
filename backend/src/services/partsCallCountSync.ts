import type { GeneratedDailyCallPlanReport } from "../types/reportGeneration.js";
import {
  mapAspCodeToRegion,
  inventoryFetch,
  inventoryApiConfigured,
} from "./inventorySyncService.js";

/**
 * OpenCall's "Active Part Cases" — active rows (no closed-synthetic, no Request-to-Cancel)
 * whose PART field is non-blank; exactly what the Overview and the record table show.
 *
 * Pushes two things to inventory, computed from the already-generated report (never
 * re-generates):
 *   - the region-wise COUNT  -> HP Stock region cards' "Active" number
 *   - the CASE ID list       -> scopes HP Stock's part-value bands to these cases
 */

export interface PartsCallCountRow {
  report_date: string;
  region: string;
  count: number;
}

export interface ActivePartCaseRow {
  report_date: string;
  case_id: string;
  region: string;
}

export interface ActivePartData {
  reportDate: string;
  counts: PartsCallCountRow[];
  cases: ActivePartCaseRow[];
}

function isRequestToCancel(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase() === "request to cancel";
}

export function computeActivePartData(
  report: GeneratedDailyCallPlanReport,
): ActivePartData {
  const reportDate = report.reportDate || "";
  const byRegion = new Map<string, number>();
  const cases: ActivePartCaseRow[] = [];
  const seenCases = new Set<string>();

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

    const caseId = String(row.enriched.case_id ?? "").trim();
    if (caseId && !seenCases.has(caseId)) {
      seenCases.add(caseId);
      cases.push({ report_date: reportDate, case_id: caseId, region });
    }
  }

  const counts = Array.from(byRegion.entries())
    .map(([region, count]) => ({ report_date: reportDate, region, count }))
    .sort((a, b) => a.region.localeCompare(b.region));

  return { reportDate, counts, cases };
}

// The frontend polls report generation every ~10s; skip the write when nothing changed.
let lastPushedFingerprint = "";

async function pushViaSqlite(data: ActivePartData): Promise<void> {
  const dbPath =
    process.env.INVENTORY_DB_PATH ||
    "c:/Users/mohamed vaseem/Documents/company ptoject/inventry-web/inventory_backend/db.sqlite3";
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    const now = new Date().toISOString();

    const countStmt = db.prepare(`
      INSERT INTO hp_stock_opencallpartscount (report_date, region, count, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(report_date, region)
      DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at
    `);
    for (const r of data.counts) {
      countStmt.run(r.report_date, r.region, r.count, now);
    }

    // Replace the whole active-case set for this report date.
    db.prepare(`DELETE FROM hp_stock_opencallactivepartcase WHERE report_date = ?`).run(
      data.reportDate,
    );
    const caseStmt = db.prepare(`
      INSERT OR IGNORE INTO hp_stock_opencallactivepartcase (report_date, case_id, region)
      VALUES (?, ?, ?)
    `);
    for (const c of data.cases) {
      caseStmt.run(c.report_date, c.case_id, c.region);
    }
  } finally {
    db.close();
  }
}

async function pushViaApi(data: ActivePartData): Promise<void> {
  const countRes = await inventoryFetch("/hp-stock/parts-call-counts/bulk_upsert/", {
    method: "POST",
    body: JSON.stringify(data.counts),
  });
  if (!countRes.ok) {
    throw new Error(`bulk_upsert failed (${countRes.status}): ${await countRes.text()}`);
  }

  const caseRes = await inventoryFetch(
    "/hp-stock/parts-call-counts/bulk_replace_active_cases/",
    { method: "POST", body: JSON.stringify(data.cases) },
  );
  if (!caseRes.ok) {
    throw new Error(
      `bulk_replace_active_cases failed (${caseRes.status}): ${await caseRes.text()}`,
    );
  }
}

export async function pushActivePartData(
  data: ActivePartData,
  force = false,
): Promise<void> {
  if (data.counts.length === 0) return;

  const fingerprint = JSON.stringify({
    counts: data.counts,
    cases: data.cases.map((c) => c.case_id).sort(),
  });
  if (!force && fingerprint === lastPushedFingerprint) {
    return; // unchanged since the last push — nothing to do
  }

  if (inventoryApiConfigured()) {
    await pushViaApi(data);
  } else {
    await pushViaSqlite(data);
  }

  lastPushedFingerprint = fingerprint;
  const total = data.counts.reduce((s, r) => s + r.count, 0);
  console.info(
    `[PartsCallCounts] Synced ${data.reportDate} — Active Part Cases: ${total} (${data.counts
      .map((r) => `${r.region} ${r.count}`)
      .join(", ")}), ${data.cases.length} case ids`,
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
    const data = computeActivePartData(report);
    void pushActivePartData(data).catch((error: unknown) => {
      console.error("[PartsCallCounts] push failed:", error);
    });
  } catch (error) {
    console.error("[PartsCallCounts] compute failed:", error);
  }
}
