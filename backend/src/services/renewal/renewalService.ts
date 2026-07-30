import {
  isRenewalLeadStatus,
  regionNameForAspCode,
  type RenewalLeadRow,
  type RenewalLeadStatus,
  type RenewalPipelineResponse,
  type RenewalPipelineSummary,
  type RenewalWindow,
  type SaveRenewalLeadInput,
  type SaveRenewalLeadResponse,
} from "@opencall/shared";
import {
  findExpiringWarranties,
  findLatestRowsForSerials,
  findLeadStates,
  findWorkLocationForSerial,
  renewalTablesPresent,
  serialHasWarrantyEntitlement,
  upsertLeadState,
  type SerialCustomerRow,
} from "../../repositories/renewalLeadRepository.js";
import type { AuthenticatedUser } from "../../types/auth.js";
import { forbidden, notFound, unprocessableEntity } from "../../utils/httpError.js";
import { findAllowedRegionsForUser } from "../rbac/regionAccessService.js";
import { aspCodesForRegion } from "../rbac/regionRowAccess.js";

/**
 * AMC / Warranty Renewal Pipeline.
 *
 * A lead is DERIVED at read time — an `hp_warranty_cache` entry whose warranty end date is
 * near, joined to the most recent report row that carried the same serial. Nothing about the
 * warranty or the call is copied, so this view can never drift from its sources and report
 * regeneration cannot affect it.
 *
 * INVARIANT — zero extra HP load: this service reads the warranty cache and NEVER enqueues a
 * lookup. The Playwright warranty worker's ~100/day budget belongs entirely to the existing
 * upload + closed-call sweep paths; the renewal list simply grows as that cache fills.
 *
 * The only write is the per-serial follow-up state (status / owner / remarks).
 */

/** How far ahead a warranty may end and still count as a lead. */
const MAX_DAYS_AHEAD = 90;
/** How far back an already-expired warranty stays a (paid-AMC) lead. */
const EXPIRED_LOOKBACK_DAYS = 180;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Today's date in IST (YYYY-MM-DD) — the same clock the warranty views use. */
function todayIstIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Whole days from `fromIso` to `toIso`; negative when `toIso` is in the past. */
function daysBetweenIso(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return 0;
  }
  return Math.round((to - from) / MS_PER_DAY);
}

function emptyStatusCounts(): Record<RenewalLeadStatus, number> {
  return {
    New: 0,
    Contacted: 0,
    Quoted: 0,
    Won: 0,
    Lost: 0,
    "Not Interested": 0,
  };
}

/**
 * The ASP work-location codes this user may see, or null when unrestricted (SUPER_ADMIN).
 * Mirrors how every other region-scoped read resolves visibility.
 */
async function allowedAspCodesForUser(
  user: AuthenticatedUser,
): Promise<Set<string> | null> {
  const regions = await findAllowedRegionsForUser(user);
  if (regions === null) {
    return null;
  }

  const allowed = new Set<string>();
  for (const region of regions) {
    for (const code of aspCodesForRegion(region)) {
      allowed.add(code);
    }
  }
  return allowed;
}

function matchesWindow(daysLeft: number, window: RenewalWindow): boolean {
  switch (window) {
    case "EXPIRING_30":
      return daysLeft >= 0 && daysLeft <= 30;
    case "EXPIRING_60":
      return daysLeft >= 0 && daysLeft <= 60;
    case "EXPIRING_90":
      return daysLeft >= 0 && daysLeft <= 90;
    case "EXPIRED":
      return daysLeft < 0;
    case "ALL":
    default:
      return true;
  }
}

function matchesSearch(row: RenewalLeadRow, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const haystack = [
    row.serial,
    row.customerName,
    row.accountName,
    row.contact,
    row.customerMail,
    row.product,
    row.ticketId,
    row.regionName,
    row.owner,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export interface RenewalPipelineOptions {
  window?: RenewalWindow;
  status?: RenewalLeadStatus | "ALL";
  search?: string;
}

/**
 * The renewal pipeline for this user: every already-looked-up serial whose warranty ends
 * within the window, with its customer facts and saved follow-up state, region-scoped.
 */
export async function getRenewalPipeline(
  user: AuthenticatedUser,
  options: RenewalPipelineOptions = {},
): Promise<RenewalPipelineResponse> {
  const emptySummary: RenewalPipelineSummary = {
    total: 0,
    expiring30: 0,
    expiring60: 0,
    expiring90: 0,
    expired: 0,
    byStatus: emptyStatusCounts(),
  };

  if (!(await renewalTablesPresent())) {
    return { rows: [], summary: emptySummary, available: false };
  }

  const today = todayIstIso();
  const warranties = await findExpiringWarranties({
    todayIso: today,
    aheadDays: MAX_DAYS_AHEAD,
    expiredLookbackDays: EXPIRED_LOOKBACK_DAYS,
  });
  if (warranties.length === 0) {
    return { rows: [], summary: emptySummary, available: true };
  }

  const serials = warranties.map((w) => w.serial);
  const [customerRows, leadStates] = await Promise.all([
    findLatestRowsForSerials(serials),
    findLeadStates(serials),
  ]);

  const customerBySerial = new Map<string, SerialCustomerRow>(
    customerRows.map((row) => [row.serial, row]),
  );
  const stateBySerial = new Map(leadStates.map((state) => [state.serial, state]));
  const allowedAspCodes = await allowedAspCodesForUser(user);

  const allRows: RenewalLeadRow[] = [];
  for (const warranty of warranties) {
    const customer = customerBySerial.get(warranty.serial);
    const workLocation = customer?.workLocation ?? "";

    // Region scoping: a REGION_ADMIN sees only serials whose latest call sat in one of
    // their ASP codes. A serial we have no report row for has no region, so it stays
    // SUPER_ADMIN-only rather than leaking into an arbitrary region's list.
    if (allowedAspCodes && !allowedAspCodes.has(workLocation.toUpperCase())) {
      continue;
    }

    const state = stateBySerial.get(warranty.serial);
    const status: RenewalLeadStatus =
      state && isRenewalLeadStatus(state.status) ? state.status : "New";

    allRows.push({
      serial: warranty.serial,
      startDate: warranty.startDate,
      endDate: warranty.endDate,
      daysLeft: daysBetweenIso(today, warranty.endDate),
      productNumber: warranty.productNumber,
      customerName: customer?.customerName ?? "",
      accountName: customer?.accountName ?? "",
      contact: customer?.contact ?? "",
      customerMail: customer?.customerMail ?? "",
      product: customer?.product ?? "",
      workLocation,
      regionName: workLocation ? regionNameForAspCode(workLocation.toUpperCase()) : "",
      ticketId: customer?.ticketId ?? "",
      lastSeenDate: customer?.reportDate ?? null,
      status,
      owner: state?.owner ?? "",
      remarks: state?.remarks ?? "",
      updatedAt: state?.updatedAt ?? null,
    });
  }

  // Summary counts describe everything this user may see, so the header chips stay stable
  // while the user narrows the list with the window / status / search filters.
  const summary: RenewalPipelineSummary = {
    total: allRows.length,
    expiring30: allRows.filter((r) => matchesWindow(r.daysLeft, "EXPIRING_30")).length,
    expiring60: allRows.filter((r) => matchesWindow(r.daysLeft, "EXPIRING_60")).length,
    expiring90: allRows.filter((r) => matchesWindow(r.daysLeft, "EXPIRING_90")).length,
    expired: allRows.filter((r) => r.daysLeft < 0).length,
    byStatus: allRows.reduce((counts, row) => {
      counts[row.status] += 1;
      return counts;
    }, emptyStatusCounts()),
  };

  const window = options.window ?? "EXPIRING_90";
  const statusFilter = options.status ?? "ALL";
  const needle = (options.search ?? "").trim().toLowerCase();

  const rows = allRows
    .filter((row) => matchesWindow(row.daysLeft, window))
    .filter((row) => statusFilter === "ALL" || row.status === statusFilter)
    .filter((row) => matchesSearch(row, needle))
    // Soonest to expire first; already-expired (most negative) last.
    .sort((a, b) => {
      if (a.daysLeft < 0 && b.daysLeft >= 0) return 1;
      if (b.daysLeft < 0 && a.daysLeft >= 0) return -1;
      return a.daysLeft - b.daysLeft;
    });

  return { rows, summary, available: true };
}

/**
 * Save the follow-up state of one lead. Only serials that are genuinely renewal leads (HP
 * resolved them with a real end date) can be saved, and a REGION_ADMIN may only save leads
 * inside their own regions.
 */
export async function saveRenewalLead(
  user: AuthenticatedUser,
  input: SaveRenewalLeadInput,
): Promise<SaveRenewalLeadResponse> {
  if (!(await renewalTablesPresent())) {
    throw unprocessableEntity(
      "Renewal pipeline is not available — run the renewal-leads migration first",
    );
  }

  const serial = (input.serial ?? "").trim().toUpperCase();
  if (!serial) {
    throw unprocessableEntity("serial is required");
  }
  if (!isRenewalLeadStatus(input.status)) {
    throw unprocessableEntity("status is not a valid renewal lead status", {
      status: input.status,
    });
  }

  if (!(await serialHasWarrantyEntitlement(serial))) {
    throw notFound("No HP warranty entitlement is cached for this serial", { serial });
  }

  const allowedAspCodes = await allowedAspCodesForUser(user);
  if (allowedAspCodes) {
    const workLocation = (await findWorkLocationForSerial(serial)).toUpperCase();
    if (!workLocation || !allowedAspCodes.has(workLocation)) {
      throw forbidden("This renewal lead is outside your region");
    }
  }

  const saved = await upsertLeadState({
    serial,
    status: input.status,
    owner: (input.owner ?? "").trim().slice(0, 200),
    remarks: (input.remarks ?? "").trim().slice(0, 2000),
    updatedBy: user.id,
  });

  return {
    serial: saved.serial,
    status: isRenewalLeadStatus(saved.status) ? saved.status : "New",
    owner: saved.owner,
    remarks: saved.remarks,
    updatedAt: saved.updatedAt,
  };
}
