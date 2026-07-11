import type { SpecialAccessPrincipal } from "../../types/auth.js";
import type { GeneratedDailyCallPlanReport } from "../../types/reportGeneration.js";
import { generateDailyCallPlanReport } from "../callPlanGenerator/dailyCallPlanGenerator.js";
import { findLatestCompletedReportSession } from "../../repositories/historyRepository.js";
import { findRegionById } from "../../repositories/regionRepository.js";
import { aspCodesForRegion } from "../rbac/regionRowAccess.js";

// --- warranty / trade classification (mirrors the frontend caseClassification.ts) ---

function normalizeWoOtcCode(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ");
}

function woOtcPrefix(value: unknown): string {
  return normalizeWoOtcCode(value).match(/^[A-Z0-9]+/)?.[0] ?? "";
}

const TRADE_KEYWORD = "TRADE";
const PRINT_INSTALLATION_PREFIX = "05F";

/** True when a row is 01-Trade / non-warranty billable work. Same rules as the dashboards. */
function isTradeRow(output: Record<string, unknown>): boolean {
  const code = normalizeWoOtcCode(output["WO OTC CODE"]);
  if (code.includes(TRADE_KEYWORD) || code.startsWith("01")) {
    return true;
  }
  const segment = String(output["Segment"] ?? "").trim().toLowerCase();
  if (segment === "trade") {
    return true;
  }
  if (segment === "pc" && woOtcPrefix(output["WO OTC CODE"]) === PRINT_INSTALLATION_PREFIX) {
    return true;
  }
  return false;
}

function matchesDataScope(
  output: Record<string, unknown>,
  scope: SpecialAccessPrincipal["dataScope"],
): boolean {
  if (scope === "warranty") return !isTradeRow(output);
  if (scope === "trade") return isTradeRow(output);
  return true; // overall
}

/** Union of ASP codes for the principal's granted regions (empty when allRegions). */
async function allowedAspCodesFor(
  principal: SpecialAccessPrincipal,
): Promise<Set<string>> {
  const codes = new Set<string>();
  for (const regionId of principal.regions) {
    const region = await findRegionById(regionId);
    if (region) {
      for (const code of aspCodesForRegion(region)) {
        codes.add(code.toUpperCase());
      }
    }
  }
  return codes;
}

export interface ScopedReportResult {
  report: GeneratedDailyCallPlanReport | null;
  dataScope: SpecialAccessPrincipal["dataScope"];
  permissionLevel: SpecialAccessPrincipal["permissionLevel"];
}

/**
 * Loads the globally-latest completed report and returns it filtered to exactly what the
 * special-access principal may see: their region set (or all regions) AND their data
 * scope (overall / warranty / trade). Filtering happens server-side, so data outside the
 * grant never reaches the browser. Returns `report: null` when no report exists yet.
 */
export async function loadScopedReportForPrincipal(
  principal: SpecialAccessPrincipal,
): Promise<ScopedReportResult> {
  const base = {
    dataScope: principal.dataScope,
    permissionLevel: principal.permissionLevel,
  };

  const session = await findLatestCompletedReportSession();
  if (!session || !session.flex_upload_batch_id) {
    return { report: null, ...base };
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

  const allowedCodes = principal.allRegions
    ? null
    : await allowedAspCodesFor(principal);

  const filteredRows = report.rows.filter((row) => {
    const output = row.output as unknown as Record<string, unknown>;
    if (!matchesDataScope(output, principal.dataScope)) {
      return false;
    }
    if (allowedCodes) {
      const workLocation = String(row.enriched.work_location ?? "")
        .trim()
        .toUpperCase();
      if (!allowedCodes.has(workLocation)) {
        return false;
      }
    }
    return true;
  });

  const filteredRegionBreakdown = allowedCodes
    ? report.regionBreakdown.filter((entry) =>
        allowedCodes.has(entry.aspCode.toUpperCase()),
      )
    : report.regionBreakdown;

  return {
    report: {
      ...report,
      rows: filteredRows,
      totalRows: filteredRows.length,
      regionBreakdown: filteredRegionBreakdown,
    },
    ...base,
  };
}
