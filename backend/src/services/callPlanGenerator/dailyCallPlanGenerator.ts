import { DAILY_CALL_PLAN_COLUMNS, regionNameForAspCode } from "@opencall/shared";
import { withTransaction } from "../../config/database.js";
import {
  findActiveSlaHoursByCategory,
  findAreaNameByPincode,
} from "../../repositories/businessRuleRepository.js";
import {
  createDailyCallPlanReport,
  findDailyCallPlanReportRowMetadataByReportId,
  findPreviousFinalReportRowsForManualCarryForward,
  insertDailyCallPlanReportRows,
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
import { manualFieldCarryForwardService } from "./manualFieldCarryForwardService.js";
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
  };
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
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

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

async function applyPersistedRowMetadata(
  client: Parameters<typeof findDailyCallPlanReportRowMetadataByReportId>[0],
  reportId: string,
  rows: GeneratedDailyCallPlanRow[],
): Promise<void> {
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
    row.enriched.case_created_time = persisted.caseCreatedTime;
    row.enriched.wip_aging = persisted.wipAging;
    row.enriched.hp_owner_status = persisted.hpOwnerStatus;
    row.enriched.rtpl_status = persisted.rtplStatus ?? "";
    row.enriched.segment = persisted.segment ?? "";
    row.enriched.engineer = persisted.engineer;
    row.enriched.location = persisted.location;
    row.enriched.customer_mail = persisted.customerMail;
    row.enriched.rca = persisted.rca;
    row.enriched.remarks = persisted.remarks;
    row.enriched.manual_notes = persisted.manualNotes;
    row.match.enrichedRow = row.enriched;
    row.carryForward.carriedForwardFields = persisted.carriedForwardFields;
    row.carryForward.manualFieldsCompleted = persisted.manualFieldsCompleted;
    row.carryForward.manualFieldsMissing = persisted.manualFieldsMissing;
    row.output = orderedDailyCallPlanRow(
      formatDailyCallPlanRow(row.serialNo, row.enriched),
    );
  }
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
      const aAging = parseInt(a.enrichedRow.wip_aging ?? "0", 10);
      const bAging = parseInt(b.enrichedRow.wip_aging ?? "0", 10);
      const valA = Number.isNaN(aAging) ? 0 : aAging;
      const valB = Number.isNaN(bAging) ? 0 : bAging;
      return valB - valA;
    });

    const generatedRows = matchedMatches.map<GeneratedDailyCallPlanRow>((match, index) => {
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
      });
    const carryForwardResult = manualFieldCarryForwardService.apply({
      currentRows: generatedRows,
      previousFinalRows,
    });
    const rows = carryForwardResult.rows;
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
      await applyPersistedRowMetadata(client, reportId, rows);
      // Recalculate again after applying metadata to ensure aging is up-to-date
      // and accounts for any manually updated case_created_time.
      updateAging();
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
