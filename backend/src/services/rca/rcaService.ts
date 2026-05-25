import {
  DEFAULT_RCA_RECENCY_DAYS,
  getRcaCaseTimeline,
  listOpenRcaCases,
  type RcaCaseTimelineEntryDb,
  type RcaOpenCaseDb,
} from "../../repositories/rcaCaseRepository.js";
import { findRegionById, listRegions, type Region } from "../../repositories/regionRepository.js";
import { aspCodesForRegion } from "../rbac/regionRowAccess.js";
import { canonicalRegionForRow, dedupeRegionsByName } from "../rbac/regionGroups.js";
import type { AuthenticatedUser } from "../../types/auth.js";
import { forbidden } from "../../utils/httpError.js";
import type { ManualCarryForwardField } from "../../types/reportGeneration.js";

export type RcaSeverity = "ok" | "warn" | "critical";

const STALE_THRESHOLD_DAYS = 2;
const CRITICAL_THRESHOLD_DAYS = 5;

const TRACKED_FIELDS: readonly ManualCarryForwardField[] = [
  "rtpl_status",
  "segment",
  "engineer",
  "location",
  "case_created_time",
  "hp_owner_status",
  "customer_mail",
  "rca",
  "remarks",
  "manual_notes",
];

export interface RcaCaseSummary {
  ticketId: string;
  ticketKey: string;
  caseId: string | null;
  customerName: string | null;
  accountName: string | null;
  customerMail: string | null;
  contact: string | null;
  workLocation: string | null;
  regionId: string | null;
  regionName: string | null;
  regionCode: string | null;
  engineer: string | null;
  status: string | null;
  segment: string | null;
  location: string | null;
  product: string | null;
  remarks: string | null;
  manualNotes: string | null;
  rca: string | null;
  caseCreatedTime: string | null;
  latestReportId: string;
  latestReportDate: string;
  firstSeenDate: string | null;
  daysOpen: number;
  daysSinceLastAction: number;
  lastActionAt: string | null;
  lastActionUserId: string | null;
  lastActionUsername: string | null;
  lastActionEmail: string | null;
  totalAppearances: number;
  totalActions: number;
  manualFieldsCompleted: boolean;
  carriedForwardFields: ManualCarryForwardField[];
  severity: RcaSeverity;
  isStale: boolean;
}

export interface RcaListSummary {
  generatedAt: string;
  latestReportDate: string | null;
  totalOpen: number;
  totalStale: number;
  totalCritical: number;
  avgDaysSinceLastAction: number;
  avgDaysOpen: number;
  staleThresholdDays: number;
  criticalThresholdDays: number;
  recencyWindowDays: number;
  regionsCovered: number;
}

export interface RcaListResult {
  summary: RcaListSummary;
  rows: RcaCaseSummary[];
  total: number;
  staleCount: number;
  criticalCount: number;
}

export interface ListRcaCasesOptions {
  regionId?: string | null;
  status?: "all" | "stale" | "critical" | "active";
  search?: string | null;
  limit?: number;
  offset?: number;
}

interface ResolvedRegionScope {
  workLocations: string[] | null;
  effectiveRegionId: string | null;
  regions: Region[];
}

function diffDaysInclusive(fromIso: string | null, toIso: string | null): number {
  if (!fromIso || !toIso) return 0;
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;
  const ms = to.getTime() - from.getTime();
  if (ms <= 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function severityFor(daysSinceLastAction: number): RcaSeverity {
  if (daysSinceLastAction >= CRITICAL_THRESHOLD_DAYS) return "critical";
  if (daysSinceLastAction >= STALE_THRESHOLD_DAYS) return "warn";
  return "ok";
}

async function resolveRegionScope(
  user: AuthenticatedUser,
  requestedRegionId: string | null | undefined,
): Promise<ResolvedRegionScope> {
  const requested = requestedRegionId?.trim() || null;

  if (user.role === "REGION_ADMIN") {
    if (!user.regionId) {
      throw forbidden("REGION_ADMIN user is not assigned to a region");
    }
    if (requested && requested !== user.regionId) {
      throw forbidden("REGION_ADMIN cannot access another region", {
        requestedRegionId: requested,
        userRegionId: user.regionId,
      });
    }
    const region = await findRegionById(user.regionId);
    if (!region) {
      throw forbidden("REGION_ADMIN user is assigned to an unknown region");
    }
    return {
      workLocations: Array.from(aspCodesForRegion(region)),
      effectiveRegionId: region.id,
      regions: [region],
    };
  }

  // SUPER_ADMIN
  if (requested) {
    const region = await findRegionById(requested);
    if (!region) {
      return { workLocations: null, effectiveRegionId: null, regions: [] };
    }
    return {
      workLocations: Array.from(aspCodesForRegion(region)),
      effectiveRegionId: region.id,
      regions: [region],
    };
  }

  return { workLocations: null, effectiveRegionId: null, regions: [] };
}

function titleCaseRegionName(name: string): string {
  if (!name) return name;
  return name
    .toLowerCase()
    .split(/\s+/)
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function mapOpenCase(row: RcaOpenCaseDb): RcaCaseSummary {
  const referenceDate = row.report_date;
  const fallbackOpenedFrom = row.first_seen_date ?? row.case_created_time;
  const daysOpen = diffDaysInclusive(fallbackOpenedFrom, referenceDate);
  const daysSinceLastAction = row.last_action_at
    ? diffDaysInclusive(row.last_action_at, referenceDate)
    : daysOpen;
  const severity = severityFor(daysSinceLastAction);
  const canonical = canonicalRegionForRow(row.work_location, row.report_region_name);

  return {
    ticketId: row.ticket_id,
    ticketKey: row.ticket_key,
    caseId: row.case_id,
    customerName: row.customer_name,
    accountName: row.account_name,
    customerMail: row.customer_mail,
    contact: row.contact,
    workLocation: row.work_location,
    regionId: row.report_region_id,
    regionName: titleCaseRegionName(canonical.name),
    regionCode: canonical.aspCode,
    engineer: row.engineer,
    status: row.rtpl_status,
    segment: row.segment,
    location: row.location,
    product: row.product,
    remarks: row.remarks,
    manualNotes: row.manual_notes,
    rca: row.rca,
    caseCreatedTime: row.case_created_time,
    latestReportId: row.report_id,
    latestReportDate: row.report_date,
    firstSeenDate: row.first_seen_date,
    daysOpen,
    daysSinceLastAction,
    lastActionAt: row.last_action_at,
    lastActionUserId: row.last_action_user_id,
    lastActionUsername: row.last_action_username,
    lastActionEmail: row.last_action_email,
    totalAppearances: Number(row.total_appearances ?? 1),
    totalActions: Number(row.total_actions ?? 0),
    manualFieldsCompleted: Boolean(row.manual_fields_completed),
    carriedForwardFields: row.carried_forward_fields ?? [],
    severity,
    isStale: severity !== "ok",
  };
}

export async function listRcaCases(
  user: AuthenticatedUser,
  options: ListRcaCasesOptions,
): Promise<RcaListResult> {
  const scope = await resolveRegionScope(user, options.regionId);
  const rawRows = await listOpenRcaCases({
    workLocations: scope.workLocations,
    search: options.search ?? null,
    recencyDays: DEFAULT_RCA_RECENCY_DAYS,
  });

  const mapped = rawRows.map(mapOpenCase);
  const latestReportDate = mapped.reduce<string | null>((acc, row) => {
    if (!row.latestReportDate) return acc;
    if (!acc || row.latestReportDate > acc) return row.latestReportDate;
    return acc;
  }, null);
  const regionsCovered = new Set(
    mapped
      .map((row) => row.regionName?.toUpperCase())
      .filter((name): name is string => Boolean(name)),
  ).size;

  const totalOpen = mapped.length;
  const staleRows = mapped.filter((row) => row.severity !== "ok");
  const criticalRows = mapped.filter((row) => row.severity === "critical");
  const totalStale = staleRows.length;
  const totalCritical = criticalRows.length;
  const avgDaysSinceLastAction = totalOpen
    ? Math.round(
        (mapped.reduce((sum, row) => sum + row.daysSinceLastAction, 0) / totalOpen) * 10,
      ) / 10
    : 0;
  const avgDaysOpen = totalOpen
    ? Math.round((mapped.reduce((sum, row) => sum + row.daysOpen, 0) / totalOpen) * 10) / 10
    : 0;

  const statusFilter = options.status ?? "all";
  const filtered = mapped.filter((row) => {
    if (statusFilter === "all") return true;
    if (statusFilter === "stale") return row.severity !== "ok";
    if (statusFilter === "critical") return row.severity === "critical";
    if (statusFilter === "active") return row.severity === "ok";
    return true;
  });

  const sorted = filtered.sort((a, b) => {
    if (b.daysSinceLastAction !== a.daysSinceLastAction) {
      return b.daysSinceLastAction - a.daysSinceLastAction;
    }
    if (b.daysOpen !== a.daysOpen) return b.daysOpen - a.daysOpen;
    return a.ticketId.localeCompare(b.ticketId);
  });

  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  const paginated = sorted.slice(offset, offset + limit);

  return {
    summary: {
      generatedAt: new Date().toISOString(),
      latestReportDate,
      totalOpen,
      totalStale,
      totalCritical,
      avgDaysSinceLastAction,
      avgDaysOpen,
      staleThresholdDays: STALE_THRESHOLD_DAYS,
      criticalThresholdDays: CRITICAL_THRESHOLD_DAYS,
      recencyWindowDays: DEFAULT_RCA_RECENCY_DAYS,
      regionsCovered,
    },
    rows: paginated,
    total: sorted.length,
    staleCount: totalStale,
    criticalCount: totalCritical,
  };
}

export interface RcaTimelineEntry {
  reportId: string;
  reportDate: string;
  reportCreatedAt: string;
  regionId: string | null;
  regionName: string | null;
  regionCode: string | null;
  workLocation: string | null;
  status: string | null;
  engineer: string | null;
  location: string | null;
  segment: string | null;
  remarks: string | null;
  manualNotes: string | null;
  rca: string | null;
  customerMail: string | null;
  caseId: string | null;
  caseCreatedTime: string | null;
  matchStatus: string;
  carriedForwardFields: ManualCarryForwardField[];
  manualFieldsCompleted: boolean;
  manualFieldsMissing: ManualCarryForwardField[];
  updatedAt: string | null;
  updatedBy: string | null;
  updatedByUsername: string | null;
  updatedByEmail: string | null;
  dayNo: number;
  daysSincePreviousEntry: number;
  changedFields: ManualCarryForwardField[];
  actionTaken: boolean;
  actionKind: "FIRST_APPEARANCE" | "MANUAL_EDIT" | "FRESH_FROM_UPLOAD" | "CARRIED_FORWARD" | "NO_CHANGE";
}

export interface RcaTimelineResponse {
  ticketId: string;
  caseId: string | null;
  customerName: string | null;
  accountName: string | null;
  customerMail: string | null;
  workLocation: string | null;
  regionId: string | null;
  regionName: string | null;
  regionCode: string | null;
  caseCreatedTime: string | null;
  firstSeenDate: string | null;
  latestReportDate: string | null;
  currentStatus: string | null;
  currentEngineer: string | null;
  currentRca: string | null;
  daysOpen: number;
  daysSinceLastAction: number;
  totalAppearances: number;
  totalActions: number;
  isStale: boolean;
  severity: RcaSeverity;
  entries: RcaTimelineEntry[];
}

function fieldValue(entry: RcaCaseTimelineEntryDb, field: ManualCarryForwardField): string | null {
  switch (field) {
    case "rtpl_status":
      return entry.rtpl_status;
    case "segment":
      return entry.segment;
    case "engineer":
      return entry.engineer;
    case "location":
      return entry.location;
    case "case_created_time":
      return entry.case_created_time;
    case "hp_owner_status":
      return null;
    case "customer_mail":
      return entry.customer_mail;
    case "rca":
      return entry.rca;
    case "remarks":
      return entry.remarks;
    case "manual_notes":
      return entry.manual_notes;
    default:
      return null;
  }
}

function buildTimelineEntries(rows: RcaCaseTimelineEntryDb[]): RcaTimelineEntry[] {
  const entries: RcaTimelineEntry[] = [];
  let previous: RcaCaseTimelineEntryDb | null = null;
  let previousDate: string | null = null;

  rows.forEach((row, index) => {
    const changedFields: ManualCarryForwardField[] = [];
    const carriedForward = new Set(row.carried_forward_fields ?? []);
    let actionKind: RcaTimelineEntry["actionKind"];

    if (!previous) {
      actionKind = "FIRST_APPEARANCE";
      for (const field of TRACKED_FIELDS) {
        const value = fieldValue(row, field);
        if (value && value.trim().length > 0) {
          changedFields.push(field);
        }
      }
    } else {
      for (const field of TRACKED_FIELDS) {
        const newValue = (fieldValue(row, field) ?? "").trim();
        const oldValue = (fieldValue(previous, field) ?? "").trim();
        if (newValue !== oldValue) {
          changedFields.push(field);
        }
      }
      if (row.updated_at) {
        actionKind = "MANUAL_EDIT";
      } else if (changedFields.length > 0) {
        const allCarried = changedFields.every((f) => carriedForward.has(f));
        actionKind = allCarried ? "CARRIED_FORWARD" : "FRESH_FROM_UPLOAD";
      } else {
        actionKind = "NO_CHANGE";
      }
    }

    const daysSincePreviousEntry = previousDate ? diffDaysInclusive(previousDate, row.report_date) : 0;
    const actionTaken =
      actionKind === "FIRST_APPEARANCE" ||
      actionKind === "MANUAL_EDIT" ||
      actionKind === "FRESH_FROM_UPLOAD";

    entries.push({
      reportId: row.report_id,
      reportDate: row.report_date,
      reportCreatedAt: row.report_created_at,
      regionId: row.region_id,
      regionName: row.region_name,
      regionCode: row.region_code,
      workLocation: row.work_location,
      status: row.rtpl_status,
      engineer: row.engineer,
      location: row.location,
      segment: row.segment,
      remarks: row.remarks,
      manualNotes: row.manual_notes,
      rca: row.rca,
      customerMail: row.customer_mail,
      caseId: row.case_id,
      caseCreatedTime: row.case_created_time,
      matchStatus: row.match_status,
      carriedForwardFields: row.carried_forward_fields ?? [],
      manualFieldsCompleted: Boolean(row.manual_fields_completed),
      manualFieldsMissing: row.manual_fields_missing ?? [],
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      updatedByUsername: row.updated_by_username,
      updatedByEmail: row.updated_by_email,
      dayNo: index + 1,
      daysSincePreviousEntry,
      changedFields,
      actionTaken,
      actionKind,
    });

    previous = row;
    previousDate = row.report_date;
  });

  return entries;
}

export async function getRcaTimeline(
  user: AuthenticatedUser,
  ticketKey: string,
): Promise<RcaTimelineResponse | null> {
  const scope = await resolveRegionScope(user, null);
  const rows = await getRcaCaseTimeline(ticketKey, scope.workLocations);
  if (rows.length === 0) return null;

  const latest = rows[rows.length - 1]!;
  const oldest = rows[0]!;
  const lastActionAt = rows
    .map((r) => r.updated_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .pop() ?? null;

  const referenceDate = latest.report_date;
  const daysOpen = diffDaysInclusive(oldest.report_date, referenceDate);
  const daysSinceLastAction = lastActionAt
    ? diffDaysInclusive(lastActionAt, referenceDate)
    : daysOpen;
  const severity = severityFor(daysSinceLastAction);

  const entries = buildTimelineEntries(rows);
  const totalActions = entries.filter((entry) => entry.actionTaken).length;
  const canonical = canonicalRegionForRow(latest.work_location, latest.region_name);

  return {
    ticketId: latest.ticket_id,
    caseId: latest.case_id,
    customerName: latest.customer_name,
    accountName: latest.account_name,
    customerMail: latest.customer_mail,
    workLocation: latest.work_location,
    regionId: latest.region_id,
    regionName: titleCaseRegionName(canonical.name),
    regionCode: canonical.aspCode,
    caseCreatedTime: latest.case_created_time,
    firstSeenDate: oldest.report_date,
    latestReportDate: latest.report_date,
    currentStatus: latest.rtpl_status,
    currentEngineer: latest.engineer,
    currentRca: latest.rca,
    daysOpen,
    daysSinceLastAction,
    totalAppearances: rows.length,
    totalActions,
    isStale: severity !== "ok",
    severity,
    entries,
  };
}

export async function listRegionsForRca(): Promise<Region[]> {
  return listRegions();
}
