import { DAILY_CALL_PLAN_COLUMNS, regionNameForAspCode } from "@opencall/shared";
import type { ReportRowComparisonInsight } from "@opencall/shared";
import { withTransaction } from "../../config/database.js";
import {
  findActiveSlaHoursByCategory,
  findAreaNameByPincode,
} from "../../repositories/businessRuleRepository.js";
import {
  backfillMissingDailyCallPlanReportRowCarryForward,
  createDailyCallPlanReport,
  findDailyCallPlanReportRowMetadataByReportId,
  findFlexStatusHistoryForUnchangedDays,
  findPreviousFinalReportRowsForManualCarryForward,
  insertDailyCallPlanReportRows,
  overwriteCarriedForwardFieldValues,
  type FlexStatusHistoryReport,
} from "../../repositories/dailyCallPlanReportRepository.js";
import { findOrCreateCompletedHistorySessionForReport } from "../../repositories/historyRepository.js";
import {
  findComparableReportRowsBySessionId,
  findPreviousCompletedComparisonSession,
  replaceReportComparison,
} from "../../repositories/reportComparisonRepository.js";
import {
  findCallPlanRecordsByBatchId,
  findFlexWipRecordsByBatchId,
  findRenderwaysRecordsByBatchId,
} from "../../repositories/sourceRecordRepository.js";
import type { ComparableReportRow } from "../../types/reportComparison.js";
import type {
  DuplicateTrackingSummary,
  MatchStatus,
} from "../../types/matching.js";
import type {
  GeneratedReportComparisonMetadata,
  GeneratedDailyCallPlanReport,
  GeneratedDailyCallPlanRow,
  GenerateDailyCallPlanInput,
  ManualCarryForwardField,
  ManualCarryForwardRowMetadata,
} from "../../types/reportGeneration.js";
import { MANUAL_CARRY_FORWARD_FIELDS } from "../../types/reportGeneration.js";
import { forbidden, unprocessableEntity } from "../../utils/httpError.js";
import { matchSourceRecords } from "../compareService/matchingEngine.js";
import {
  dedupeRowsByTicket,
  findDuplicateTicketKeys,
  getNormalizedTicketKey,
} from "../normalization/dedupeRowsByTicket.js";
import {
  buildReportComparison,
} from "../reportComparison/compareReportsService.js";
import {
  formatDailyCallPlanRow,
  orderedDailyCallPlanRow,
} from "./dailyCallPlanFormatter.js";
import { computeFlexStatusUnchangedDaysFromHistory } from "./flexStatusUnchangedDays.js";
import {
  cleanManualValue,
  manualFieldCarryForwardService,
} from "./manualFieldCarryForwardService.js";
import { validateReportGenerationTransaction } from "./reportGenerationValidation.js";
import { calculateWipAging } from "../compareService/wipAgingCalculator.js";

function countDuplicateTickets(rows: readonly GeneratedDailyCallPlanRow[]): number {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const ticketId = String(row.output["Ticket ID"] ?? "").trim();

    if (!ticketId) {
      continue;
    }

    counts.set(ticketId, (counts.get(ticketId) ?? 0) + 1);
  }
  return Array.from(counts.values()).filter((count) => count > 1).length;
}

function countUnmatchedRows(
  rows: readonly GeneratedDailyCallPlanRow[],
): number {
  const unmatchedStatuses: ReadonlySet<MatchStatus> = new Set([
    "RENDERWAYS_MISSING",
    "FLEX_MISSING",
    "CALLPLAN_MISSING",
    "BOTH_MISSING",
  ]);

  return rows.filter((row) =>
    !row.carryForward.closedSyntheticRow &&
    !row.carryForward.regionScopeRetainedRow &&
    unmatchedStatuses.has(row.enriched.match_status),
  ).length;
}

function initialCarryForwardMetadata(): ManualCarryForwardRowMetadata {
  return {
    carriedForwardFields: [],
    manualFieldsCompleted: false,
    manualFieldsMissing: [...MANUAL_CARRY_FORWARD_FIELDS],
    changeType: null,
    previousTicketMatched: false,
    closedSyntheticRow: false,
    sameDayClosedRow: false,
    regionScopeRetainedRow: false,
  };
}

function getOtcSortWeight(code: string): number {
  const normalized = code.trim().toUpperCase();
  if (normalized.includes("TRADE")) {
    return 6;
  }
  if (normalized.startsWith("05F") || normalized.startsWith("O5F")) {
    return 1;
  }
  if (normalized.startsWith("05K") || normalized.startsWith("O5K")) {
    return 2;
  }
  if (normalized.startsWith("02N") || normalized.startsWith("O2N")) {
    return 3;
  }
  if (normalized.startsWith("00C") || normalized.startsWith("OOC")) {
    return 4;
  }
  return 5;
}

function computeRegionBreakdown(
  rows: readonly GeneratedDailyCallPlanRow[],
): import("../../types/reportGeneration.js").RegionBreakdownEntry[] {
  const regionMap = new Map<string, { count: number; closedCount: number; woOtcCodes: Map<string, number> }>();

  for (const row of rows) {
    let aspCode = (row.enriched.work_location || "").trim().toUpperCase();
    if (!aspCode) {
      aspCode = "UNKNOWN";
    }

    let woCode = (row.enriched.wo_otc_code || "").trim();
    if (!woCode) {
      woCode = "Unspecified";
    }

    let regionData = regionMap.get(aspCode);
    if (!regionData) {
      regionData = { count: 0, closedCount: 0, woOtcCodes: new Map() };
      regionMap.set(aspCode, regionData);
    }

    if (row.carryForward.closedSyntheticRow) {
      regionData.closedCount++;
      continue;
    }

    regionData.count++;
    regionData.woOtcCodes.set(woCode, (regionData.woOtcCodes.get(woCode) ?? 0) + 1);
  }

  const breakdown = Array.from(regionMap.entries()).map(([aspCode, data]) => {
    const woOtcCodeBreakdown = Array.from(data.woOtcCodes.entries())
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => {
        const weightA = getOtcSortWeight(a.code);
        const weightB = getOtcSortWeight(b.code);
        if (weightA !== weightB) {
          return weightA - weightB;
        }
        return a.code.localeCompare(b.code);
      });

    return {
      aspCode,
      regionName: regionNameForAspCode(aspCode),
      count: data.count,
      closedCount: data.closedCount,
      woOtcCodeBreakdown,
    };
  });

  // Sort descending by count, then alphabetically by region name
  breakdown.sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return a.regionName.localeCompare(b.regionName);
  });

  return breakdown;
}

function toComparableReportRow(
  row: GeneratedDailyCallPlanRow,
): ComparableReportRow {
  return {
    rowNumber: row.serialNo,
    ticketId: row.enriched.ticket_id,
    flexStatus: row.enriched.flex_status,
    rtplStatus: row.enriched.rtpl_status,
    wipAging: row.enriched.wip_aging,
    wipAgingCategory: row.enriched.wip_aging_category,
    tat: row.enriched.tat,
    engineer: row.enriched.engineer,
    location: row.enriched.location,
  };
}

function skippedComparisonMetadata(
  currentSessionId: string,
): GeneratedReportComparisonMetadata {
  return {
    skipped: true,
    reason: "NO_PREVIOUS_REPORT",
    currentSessionId,
    previousSessionId: null,
    summary: null,
    duplicateTicketIds: {
      current: [],
      previous: [],
    },
  };
}

function applyComparisonToGeneratedRows(
  rows: GeneratedDailyCallPlanRow[],
  comparison: ReturnType<typeof buildReportComparison>,
): void {
  const insightByRowNumber = new Map(
    comparison.rowDiffs
      .filter((diff) => diff.currentRow)
      .map((diff) => [diff.currentRow!.rowNumber, diff.insight]),
  );

  for (const row of rows) {
    row.comparison = insightByRowNumber.get(row.serialNo) ?? row.comparison;
  }
}

function emptyComparisonInsight(): ReportRowComparisonInsight {
  return {
    changeType: null,
    previousFlexStatus: null,
    previousRtplStatus: null,
    previousWipAging: null,
    changedFields: {},
    changeSummary: null,
    flexStatusUnchangedDays: null,
  };
}

/**
 * Computes the "Flex Status unchanged for X days" counter for each row from the
 * actual Flex Status history (one prior report per calendar day, ordered
 * most-recent first), matched by normalized ticket id. The value is real
 * calendar days: the number of days from today back to the oldest consecutive
 * prior report that still carried the ticket's current Flex Status, so multi-day
 * gaps between non-daily reports are bridged. The result is attached to each
 * row's comparison insight so it serializes to
 * `row.comparison.flexStatusUnchangedDays`.
 */
function applyFlexStatusUnchangedDaysToRows(
  rows: GeneratedDailyCallPlanRow[],
  flexStatusHistory: readonly FlexStatusHistoryReport[],
  reportDate: string,
): void {
  const hadPreviousReport = flexStatusHistory.length > 0;

  // One normalized-ticket -> Flex Status map per prior report (plus its date),
  // preserving the most-recent-first ordering returned by the repository.
  const historyMaps = flexStatusHistory.map((report) => {
    const flexByTicket = new Map<string, string | null>();
    for (const entry of report.entries) {
      const ticketKey = getNormalizedTicketKey(entry.ticketId);
      if (!ticketKey || flexByTicket.has(ticketKey)) {
        continue;
      }
      flexByTicket.set(ticketKey, entry.flexStatus);
    }
    return { reportDate: report.reportDate, flexByTicket };
  });

  for (const row of rows) {
    const ticketKey = getNormalizedTicketKey(row.enriched.ticket_id);

    // This ticket's Flex Status in each prior report (most-recent first).
    // `undefined` = ticket absent that day (breaks the run); `null` = blank.
    const previousReports = ticketKey
      ? historyMaps.map((history) => ({
          reportDate: history.reportDate,
          flexStatus: history.flexByTicket.has(ticketKey)
            ? history.flexByTicket.get(ticketKey) ?? null
            : undefined,
        }))
      : [];

    const flexStatusUnchangedDays = computeFlexStatusUnchangedDaysFromHistory({
      currentFlexStatus: row.enriched.flex_status,
      reportDate,
      previousReports,
      hadPreviousReport,
    });

    if (row.comparison) {
      row.comparison.flexStatusUnchangedDays = flexStatusUnchangedDays;
    } else if (flexStatusUnchangedDays !== null) {
      row.comparison = {
        ...emptyComparisonInsight(),
        flexStatusUnchangedDays,
      };
    }
  }
}

function activeRowsForComparison(
  rows: readonly GeneratedDailyCallPlanRow[],
): GeneratedDailyCallPlanRow[] {
  return rows.filter((row) => !row.carryForward.closedSyntheticRow);
}

function getRenderwaysWipAging(row: GeneratedDailyCallPlanRow): string | null {
  const value = row.match.renderways?.wipAging;

  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  return value;
}

function countMissingRtplRows(rows: readonly GeneratedDailyCallPlanRow[]): number {
  return rows.filter(
    (row) =>
      !row.carryForward.closedSyntheticRow &&
      // Out-of-scope retained rows belong to another region's uploader; their
      // missing Morning status is not this upload's problem to chase.
      !row.carryForward.regionScopeRetainedRow &&
      !cleanManualValue(row.enriched.rtpl_status),
  ).length;
}

function manualFieldValue(
  row: GeneratedDailyCallPlanRow,
  field: ManualCarryForwardField,
): string | null {
  const value = row.enriched[field];
  return value === null || value === undefined ? null : String(value);
}

function setManualFieldValue(
  row: GeneratedDailyCallPlanRow,
  field: ManualCarryForwardField,
  value: string | null,
): void {
  switch (field) {
    case "rtpl_status":
      row.enriched.rtpl_status = value ?? "";
      return;
    case "segment":
      row.enriched.segment = value ?? "";
      return;
    case "engineer":
      row.enriched.engineer = value;
      return;
    case "location":
      row.enriched.location = value;
      return;
    case "case_created_time":
      row.enriched.case_created_time = value;
      return;
    case "hp_owner_status":
      row.enriched.hp_owner_status = value;
      return;
    case "status_aging":
      row.enriched.status_aging = value;
      return;
    case "customer_mail":
      row.enriched.customer_mail = value;
      return;
    case "rca":
      row.enriched.rca = value;
      return;
    case "remarks":
      row.enriched.remarks = value;
      return;
    case "manual_notes":
      row.enriched.manual_notes = value;
      return;
  }
}

function persistedManualFieldValue(
  persisted: Awaited<
    ReturnType<typeof findDailyCallPlanReportRowMetadataByReportId>
  >[number],
  field: ManualCarryForwardField,
): string | null {
  switch (field) {
    case "rtpl_status":
      return persisted.rtplStatus;
    case "segment":
      return persisted.segment;
    case "engineer":
      return persisted.engineer;
    case "location":
      return persisted.location;
    case "case_created_time":
      return persisted.caseCreatedTime;
    case "hp_owner_status":
      return persisted.hpOwnerStatus;
    case "status_aging":
      return (persisted as any).statusAging ?? null;
    case "customer_mail":
      return persisted.customerMail;
    case "rca":
      return persisted.rca;
    case "remarks":
      return persisted.remarks;
    case "manual_notes":
      return persisted.manualNotes;
  }
}

function applyPreviousComparisonRtplFallback(
  row: GeneratedDailyCallPlanRow,
  carriedForwardFields: Set<ManualCarryForwardField>,
): boolean {
  if (cleanManualValue(row.enriched.rtpl_status)) {
    return false;
  }

  const previousRtplStatus = cleanManualValue(row.comparison?.previousRtplStatus);
  if (!previousRtplStatus) {
    return false;
  }

  row.enriched.rtpl_status = previousRtplStatus;
  carriedForwardFields.add("rtpl_status");
  row.carryForward.previousTicketMatched = true;
  row.carryForward.changeType ??= "CARRIED";
  return true;
}

function refreshCarryForwardMetadata(row: GeneratedDailyCallPlanRow): void {
  row.carryForward.manualFieldsMissing = MANUAL_CARRY_FORWARD_FIELDS.filter(
    (field) => !cleanManualValue(row.enriched[field]),
  );
  row.carryForward.manualFieldsCompleted =
    row.carryForward.manualFieldsMissing.length === 0;
}

function applyComparisonRtplFallbackToRows(
  rows: GeneratedDailyCallPlanRow[],
): number {
  let fallbackCount = 0;

  for (const row of rows) {
    const carriedForwardFields = new Set<ManualCarryForwardField>(
      row.carryForward.carriedForwardFields,
    );

    if (!applyPreviousComparisonRtplFallback(row, carriedForwardFields)) {
      continue;
    }

    row.carryForward.carriedForwardFields = [...carriedForwardFields];
    refreshCarryForwardMetadata(row);
    row.match.enrichedRow = row.enriched;
    row.output = orderedDailyCallPlanRow(
      formatDailyCallPlanRow(row.serialNo, row.enriched),
    );
    fallbackCount += 1;
  }

  return fallbackCount;
}

async function applyPersistedRowMetadata(
  client: Parameters<typeof findDailyCallPlanReportRowMetadataByReportId>[0],
  reportId: string,
  rows: GeneratedDailyCallPlanRow[],
): Promise<GeneratedDailyCallPlanRow[]> {
  const metadata = await findDailyCallPlanReportRowMetadataByReportId(
    client,
    reportId,
  );
  const metadataByTicket = new Map(
    metadata.map((row) => [getNormalizedTicketKey(row.ticketId), row]),
  );

  for (const row of rows) {
    const ticketKey = getNormalizedTicketKey(row.enriched.ticket_id);
    const persisted = metadataByTicket.get(ticketKey);

    if (!persisted) {
      continue;
    }

    row.id = persisted.id;
    row.updatedAt = persisted.updatedAt;
    row.updatedBy = persisted.updatedBy;
    row.enriched.wip_aging = persisted.wipAging;
    const carriedForwardFields = new Set<ManualCarryForwardField>(
      persisted.carriedForwardFields,
    );
    const repairedFields: ManualCarryForwardField[] = [];
    // Inherited-only fields whose value changed at the source (the latest prior
    // report) since this report was generated. These must be overwritten in the
    // persisted row, not just filled-if-empty, so the freshest work survives.
    const refreshedFields: ManualCarryForwardField[] = [];

    for (const field of [
      ...MANUAL_CARRY_FORWARD_FIELDS,
      "remarks",
      "manual_notes",
    ] as const) {
      // Segment is recomputed from the FieldEZ file on every run (getSegment);
      // the persisted value must never override it, otherwise a stale segment
      // (e.g. a raw "MPS", or a pre-fix warranty/trade split) is frozen across
      // regenerations. Keep it out of the manual persisted-override entirely.
      if (field === "segment") {
        continue;
      }

      const persistedValue = persistedManualFieldValue(persisted, field);
      const generatedValue = manualFieldValue(row, field);

      if (field === "status_aging") {
        if (cleanManualValue(generatedValue)) {
          setManualFieldValue(row, field, generatedValue);
          carriedForwardFields.delete(field);
          continue;
        }

        if (cleanManualValue(persistedValue)) {
          setManualFieldValue(row, field, persistedValue);
          carriedForwardFields.add(field);
          continue;
        }

        setManualFieldValue(row, field, null);
        carriedForwardFields.delete(field);
        continue;
      }

      // A field this report only *inherited* (carried forward, never manually
      // edited here — so it is still in the persisted carried-forward set) must
      // track its source. If the latest prior report now holds a newer value
      // (e.g. an edit made on that report after this one was generated), adopt
      // it instead of this report's frozen snapshot. Fields genuinely edited on
      // this report have been removed from carried_forward_fields on save, so
      // they fall through to the persisted-value-wins branch below.
      const wasInheritedOnly = persisted.carriedForwardFields.includes(field);
      if (
        wasInheritedOnly &&
        cleanManualValue(generatedValue) &&
        cleanManualValue(generatedValue) !== cleanManualValue(persistedValue)
      ) {
        setManualFieldValue(row, field, generatedValue);
        carriedForwardFields.add(field);
        refreshedFields.push(field);
        continue;
      }

      if (cleanManualValue(persistedValue)) {
        setManualFieldValue(row, field, persistedValue);
        continue;
      }

      if (cleanManualValue(generatedValue)) {
        setManualFieldValue(row, field, generatedValue);
        if (row.carryForward.carriedForwardFields.includes(field)) {
          repairedFields.push(field);
          carriedForwardFields.add(field);
        }
        continue;
      }

      setManualFieldValue(row, field, persistedValue);
      carriedForwardFields.delete(field);
    }

    if (applyPreviousComparisonRtplFallback(row, carriedForwardFields)) {
      repairedFields.push("rtpl_status");
    }

    // Restore this report's own persisted Evening (EOD) status. Evening is not
    // a carry-forward manual field (Morning=rtpl_status carries; Evening is
    // per-report and set to blank at each new day's upload), so it is restored
    // directly from the persisted snapshot rather than through the field loop.
    row.enriched.evening_rtpl_status = persisted.eveningRtplStatus;

    row.match.enrichedRow = row.enriched;
    row.carryForward.carriedForwardFields = [...carriedForwardFields];
    refreshCarryForwardMetadata(row);
    row.output = orderedDailyCallPlanRow(
      formatDailyCallPlanRow(row.serialNo, row.enriched),
    );

    if (refreshedFields.length > 0) {
      // Overwrite: an inherited field's source value actually changed, so the
      // frozen snapshot must be replaced (fill-if-empty would keep the stale
      // value and lose the newer work on the next day's carry-forward).
      await overwriteCarriedForwardFieldValues(client, {
        rowId: persisted.id,
        rtplStatus: row.enriched.rtpl_status,
        engineer: row.enriched.engineer,
        location: row.enriched.location,
        caseCreatedTime: row.enriched.case_created_time,
        hpOwnerStatus: row.enriched.hp_owner_status,
        statusAging: row.enriched.status_aging,
        customerMail: row.enriched.customer_mail,
        rca: row.enriched.rca,
        remarks: row.enriched.remarks,
        manualNotes: row.enriched.manual_notes,
        carriedForwardFields: row.carryForward.carriedForwardFields,
        manualFieldsCompleted: row.carryForward.manualFieldsCompleted,
        manualFieldsMissing: row.carryForward.manualFieldsMissing,
      });
    } else if (repairedFields.length > 0) {
      await backfillMissingDailyCallPlanReportRowCarryForward(client, {
        rowId: persisted.id,
        rtplStatus: row.enriched.rtpl_status,
        segment: row.enriched.segment,
        engineer: row.enriched.engineer,
        location: row.enriched.location,
        caseCreatedTime: row.enriched.case_created_time,
        hpOwnerStatus: row.enriched.hp_owner_status,
        statusAging: row.enriched.status_aging,
        customerMail: row.enriched.customer_mail,
        rca: row.enriched.rca,
        remarks: row.enriched.remarks,
        manualNotes: row.enriched.manual_notes,
        carriedForwardFields: row.carryForward.carriedForwardFields,
        manualFieldsCompleted: row.carryForward.manualFieldsCompleted,
        manualFieldsMissing: row.carryForward.manualFieldsMissing,
      });
    }
  }

  return rows.filter((row) => {
    const ticketKey = getNormalizedTicketKey(row.enriched.ticket_id);
    const persisted = ticketKey ? metadataByTicket.get(ticketKey) : null;
    return !persisted?.isExcluded;
  });
}

function metadataFromComparison(
  comparison: ReturnType<typeof buildReportComparison>,
): GeneratedReportComparisonMetadata {
  return {
    skipped: false,
    reason: null,
    currentSessionId: comparison.currentSessionId,
    previousSessionId: comparison.previousSessionId,
    summary: comparison.summary,
    duplicateTicketIds: comparison.duplicateTicketIds,
  };
}

function assertNoResidualDuplicates(
  label: string,
  rows: Parameters<typeof dedupeRowsByTicket>[0],
): void {
  const duplicateTicketKeys = findDuplicateTicketKeys(rows);

  if (duplicateTicketKeys.length > 0) {
    throw unprocessableEntity(`Duplicate ticket IDs remain after ${label} dedupe`, {
      duplicateTicketKeys,
    });
  }
}

export async function generateDailyCallPlanReport(
  input: GenerateDailyCallPlanInput,
): Promise<GeneratedDailyCallPlanReport> {
  return withTransaction(async (client) => {
    const existingReportId = await validateReportGenerationTransaction(client, input);

    if (!existingReportId && input.allowCreate === false) {
      throw forbidden(
        "Only a SUPER_ADMIN can generate a new report. Open an existing report from history instead.",
      );
    }

    const flexWip = await findFlexWipRecordsByBatchId(
      client,
      input.flexUploadBatchId,
    );
    const renderways = input.renderwaysUploadBatchId
      ? await findRenderwaysRecordsByBatchId(
          client,
          input.renderwaysUploadBatchId,
        )
      : [];
    const callPlan = input.callPlanUploadBatchId
      ? await findCallPlanRecordsByBatchId(
          client,
          input.callPlanUploadBatchId,
        )
      : [];

    if (flexWip.length === 0) {
      throw unprocessableEntity("Flex WIP batch has no persisted rows", {
        flexRows: flexWip.length,
      });
    }

    const dedupedFlexWip = dedupeRowsByTicket(flexWip);
    const dedupedRenderways = dedupeRowsByTicket(renderways);
    const dedupedCallPlan = dedupeRowsByTicket(callPlan);

    assertNoResidualDuplicates("Flex WIP", dedupedFlexWip.dedupedRows);
    assertNoResidualDuplicates("Renderways", dedupedRenderways.dedupedRows);
    assertNoResidualDuplicates("Call Plan", dedupedCallPlan.dedupedRows);

    const duplicateTracking: DuplicateTrackingSummary = {
      flexWip: dedupedFlexWip.duplicateCount,
      renderways: dedupedRenderways.duplicateCount,
      callPlan: dedupedCallPlan.duplicateCount,
      total:
        dedupedFlexWip.duplicateCount +
        dedupedRenderways.duplicateCount +
        dedupedCallPlan.duplicateCount,
    };

    if (duplicateTracking.total > 0) {
      console.info("[dailyCallPlanGenerator] Removed duplicate rows before matching", duplicateTracking);
    }

    const slaHoursByWipAgingCategory = await findActiveSlaHoursByCategory(client);
    const areaNameByPincode = await findAreaNameByPincode(
      client,
      input.regionId,
    );
    const matches = matchSourceRecords({
      flexWip: dedupedFlexWip.dedupedRows,
      renderways: dedupedRenderways.dedupedRows,
      callPlan: dedupedCallPlan.dedupedRows,
      slaHoursByWipAgingCategory,
      areaNameByPincode,
    });
    const matchedMatches = matches.filter((match) => match.flexWip !== null);
    
    matchedMatches.sort((a, b) => {
      const aTime = a.enrichedRow.case_created_time ? new Date(a.enrichedRow.case_created_time).getTime() : 0;
      const bTime = b.enrichedRow.case_created_time ? new Date(b.enrichedRow.case_created_time).getTime() : 0;
      
      if (bTime !== aTime) {
        return bTime - aTime;
      }

      const aAging = parseInt(a.enrichedRow.wip_aging ?? "0", 10);
      const bAging = parseInt(b.enrichedRow.wip_aging ?? "0", 10);
      const valA = Number.isNaN(aAging) ? 0 : aAging;
      const valB = Number.isNaN(bAging) ? 0 : bAging;
      return valB - valA;
    });

    // Region scope only applies when CREATING a report from a fresh upload. Reopening
    // an existing report regenerates it unrestricted (as today) and relies on the
    // response-level region filter, so a scoped regenerate can never rewrite another
    // region's persisted rows.
    const allowedWorkLocations =
      !existingReportId && input.allowedRegionAspCodes
        ? new Set(
            input.allowedRegionAspCodes.map((code) => code.trim().toUpperCase()),
          )
        : null;
    // Out-of-scope file rows are ignored entirely: a region-scoped upload adds no
    // new cases outside its regions, and its (possibly stale) data for other
    // regions' existing tickets is discarded — those tickets are carried forward
    // verbatim by the carry-forward service instead.
    const scopedMatches = allowedWorkLocations
      ? matchedMatches.filter((match) => {
          const aspCode = (match.enrichedRow.work_location ?? "").trim().toUpperCase();
          return aspCode.length > 0 && allowedWorkLocations.has(aspCode);
        })
      : matchedMatches;

    const generatedRows = scopedMatches.map<GeneratedDailyCallPlanRow>((match, index) => {
      const serialNo = index + 1;

      return {
        id: null,
        serialNo,
        enriched: match.enrichedRow,
        match,
        comparison: null,
        carryForward: initialCarryForwardMetadata(),
        updatedAt: null,
        updatedBy: null,
        rowEditable: true,
        carryForwardSource: "PREVIOUS_FINAL_REPORT",
        output: orderedDailyCallPlanRow(
          formatDailyCallPlanRow(serialNo, match.enrichedRow),
        ),
      };
    });
    const previousFinalRows =
      await findPreviousFinalReportRowsForManualCarryForward(client, {
        reportDate: input.reportDate,
        regionId: input.regionId,
        // Never carry forward from the report currently being regenerated; the
        // most recent *other* report (incl. an earlier one uploaded today) is
        // the source so same-day manual work is preserved.
        excludeReportId: existingReportId,
      });
    // Full Flex Status history (one report per prior day, most-recent first) so
    // the unchanged-days streak is computed from actual history, not a counter.
    const flexStatusHistory = await findFlexStatusHistoryForUnchangedDays(
      client,
      {
        reportDate: input.reportDate,
        regionId: input.regionId,
      },
    );
    const carryForwardResult = manualFieldCarryForwardService.apply({
      currentRows: generatedRows,
      previousFinalRows,
      currentReportDate: input.reportDate,
      allowedWorkLocations,
    });
    let rows = carryForwardResult.rows;
    console.info("[dailyCallPlanGenerator] RTPL carry-forward input", {
      reportDate: input.reportDate,
      regionId: input.regionId,
      previousFinalRows: previousFinalRows.length,
      generatedRows: generatedRows.length,
      rowsAfterCarryForward: rows.length,
      totalFieldsCarried: carryForwardResult.summary.totalFieldsCarried,
      missingRtplAfterCarryForward: countMissingRtplRows(rows),
    });
    const duplicateTicketCount = countDuplicateTickets(rows);
    const unmatchedTicketCount = countUnmatchedRows(rows);
    
    let reportId = existingReportId;
    if (!reportId) {
      reportId = await createDailyCallPlanReport(client, input, {
        totalRows: rows.length,
        duplicateTicketCount,
        unmatchedTicketCount,
      });
    }

    const historySession = await findOrCreateCompletedHistorySessionForReport(
      client,
      {
        userId: input.generatedBy,
        title: `Report Session ${input.reportDate}`,
        regionId: input.regionId,
        flexUploadBatchId: input.flexUploadBatchId,
        renderwaysUploadBatchId: input.renderwaysUploadBatchId ?? null,
        callPlanUploadBatchId: input.callPlanUploadBatchId ?? null,
        dailyCallPlanReportId: reportId,
        totalRows: rows.length,
      },
    );
    let comparison: GeneratedReportComparisonMetadata;

    const previousSession = await findPreviousCompletedComparisonSession(
      client,
      historySession.id,
    );

    if (!previousSession) {
      comparison = skippedComparisonMetadata(historySession.id);
    } else {
      const previousRows = await findComparableReportRowsBySessionId(
        client,
        previousSession.id,
      );
      const reportComparison = buildReportComparison({
        currentSessionId: historySession.id,
        previousSessionId: previousSession.id,
        currentRows: activeRowsForComparison(rows).map(toComparableReportRow),
        previousRows,
      });

      applyComparisonToGeneratedRows(rows, reportComparison);
      const comparisonRtplFallbackCount = applyComparisonRtplFallbackToRows(rows);
      console.info("[dailyCallPlanGenerator] RTPL comparison fallback", {
        reportDate: input.reportDate,
        regionId: input.regionId,
        previousSessionId: previousSession.id,
        comparisonRtplFallbackCount,
        missingRtplAfterComparisonFallback: countMissingRtplRows(rows),
      });
      if (!existingReportId) {
        await replaceReportComparison(client, {
          currentSessionId: reportComparison.currentSessionId,
          previousSessionId: reportComparison.previousSessionId,
          summary: reportComparison.summary,
          rowDiffs: reportComparison.rowDiffs.map((diff) => ({
            ticketId: diff.ticketId,
            changeType: diff.changeType,
            changedFields: diff.changedFields,
          })),
        });
      }
      comparison = metadataFromComparison(reportComparison);
    }

    // Compute the "Flex Status unchanged for X days" counter (real calendar
    // days) from the Flex Status history, matched by normalized ticket id. Runs
    // whether or not a previous comparison session exists so it is always set.
    applyFlexStatusUnchangedDaysToRows(rows, flexStatusHistory, input.reportDate);

    // Prefer Renderways WIP Aging when uploaded; otherwise calculate from case_created_time.
    const reportNow = new Date();
    const updateAging = () => {
      for (const row of rows) {
        const renderwaysWipAging = getRenderwaysWipAging(row);

        if (renderwaysWipAging !== null) {
          row.enriched.wip_aging = renderwaysWipAging;
          row.output["WIP aging"] = renderwaysWipAging;
          continue;
        }

        const computed = calculateWipAging(row.enriched.case_created_time, reportNow);
        if (computed !== null) {
          row.enriched.wip_aging = computed;
          row.output["WIP aging"] = computed;
        }
      }
    };

    if (!existingReportId) {
      updateAging();
      await insertDailyCallPlanReportRows(client, reportId, rows);
    } else {
      rows = await applyPersistedRowMetadata(client, reportId, rows);
      console.info("[dailyCallPlanGenerator] RTPL persisted metadata applied", {
        reportDate: input.reportDate,
        regionId: input.regionId,
        reportId,
        missingRtplAfterPersistedMetadata: countMissingRtplRows(rows),
      });
      // Recalculate again after applying metadata to ensure aging is up-to-date
      // and accounts for any manually updated case_created_time.
      updateAging();
    }

    // Surface raw Flex WIP Excel columns (those not already a mapped report
    // column) into each row's output, so a user's chosen layout can display any
    // raw field on the records grid and in the export. Closed synthetic rows
    // have no source Flex row and are left as-is.
    for (const row of rows) {
      const raw = row.match?.flexWip?.rawRow;
      if (!raw) {
        continue;
      }
      const output = row.output as Record<string, string | number>;
      for (const [key, rawValue] of Object.entries(raw)) {
        if (key in output) {
          continue;
        }
        output[key] =
          rawValue === null || rawValue === undefined
            ? ""
            : typeof rawValue === "number"
              ? rawValue
              : String(rawValue);
      }
    }

    return {
      reportId: reportId as string,
      sessionId: historySession.id,
      reportDate: input.reportDate,
      columns: DAILY_CALL_PLAN_COLUMNS,
      totalRows: rows.length,
      duplicateTicketCount,
      unmatchedTicketCount,
      duplicateTracking,
      carryForward: carryForwardResult.summary,
      comparison,
      regionBreakdown: computeRegionBreakdown(rows),
      rows,
    };
  });
}
