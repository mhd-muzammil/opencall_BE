import type { SpecialAccessPrincipal } from "../../types/auth.js";
import {
  findDailyCallPlanReportRowForEdit,
  findReportRowScopeFields,
  type EditedReportRow,
} from "../../repositories/dailyCallPlanReportRepository.js";
import { findRegionById } from "../../repositories/regionRepository.js";
import { aspCodesForRegion } from "../rbac/regionRowAccess.js";
import {
  applyReportRowManualFieldEdit,
  type ReportRowEditInput,
} from "../reportRows/reportRowEditService.js";
import { forbidden, unprocessableEntity } from "../../utils/httpError.js";

/**
 * Report-row editing for a SPECIAL ACCESS credential.
 *
 * A credential may only edit a row it is actually allowed to SEE — the same two filters
 * `specialAccessReportService` applies when serving its scoped report:
 *   1. region  — the row's work location must be in one of its granted regions
 *                (skipped when `allRegions`)
 *   2. data scope — overall / warranty / trade
 * On top of that it must hold the `edit` permission level and the `records` section.
 * All of this is enforced here, server-side; the browser is never trusted.
 */

// --- warranty / trade classification (same rules as specialAccessReportService) ---

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

function isTradeRow(woOtcCode: string | null, segment: string | null): boolean {
  const code = normalizeWoOtcCode(woOtcCode);
  if (code.includes(TRADE_KEYWORD) || code.startsWith("01")) {
    return true;
  }
  const seg = String(segment ?? "").trim().toLowerCase();
  if (seg === "trade") {
    return true;
  }
  if (seg === "pc" && woOtcPrefix(woOtcCode) === PRINT_INSTALLATION_PREFIX) {
    return true;
  }
  return false;
}

function matchesDataScope(
  woOtcCode: string | null,
  segment: string | null,
  scope: SpecialAccessPrincipal["dataScope"],
): boolean {
  if (scope === "warranty") return !isTradeRow(woOtcCode, segment);
  if (scope === "trade") return isTradeRow(woOtcCode, segment);
  return true; // overall
}

/** Union of ASP codes for the principal's granted regions. */
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

export async function updateReportRowForSpecialAccess(input: {
  rowId: string;
  principal: SpecialAccessPrincipal;
  values: ReportRowEditInput;
}): Promise<EditedReportRow> {
  const { rowId, principal, values } = input;

  if (principal.permissionLevel !== "edit") {
    throw forbidden("This credential is view-only and cannot edit report rows");
  }
  if (!principal.sections.includes("records")) {
    throw forbidden("The Records Table section is not granted to this credential");
  }

  const scope = await findReportRowScopeFields(rowId);
  if (!scope) {
    throw unprocessableEntity("Report row does not exist", { rowId });
  }

  if (!principal.allRegions) {
    const allowedCodes = await allowedAspCodesFor(principal);
    const workLocation = String(scope.workLocation ?? "")
      .trim()
      .toUpperCase();
    if (!allowedCodes.has(workLocation)) {
      throw forbidden("Cannot edit report rows outside your granted regions", {
        rowWorkLocation: scope.workLocation,
      });
    }
  }

  if (!matchesDataScope(scope.woOtcCode, scope.segment, principal.dataScope)) {
    throw forbidden("Cannot edit report rows outside your data scope", {
      dataScope: principal.dataScope,
    });
  }

  const current = await findDailyCallPlanReportRowForEdit(rowId);
  if (!current) {
    throw unprocessableEntity("Report row does not exist", { rowId });
  }

  return applyReportRowManualFieldEdit({
    rowId,
    current,
    values,
    editor: { kind: "SPECIAL_ACCESS", id: principal.id },
  });
}
