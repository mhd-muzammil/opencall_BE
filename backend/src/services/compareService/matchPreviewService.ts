import { pool } from "../../config/database.js";
import {
  findCallPlanRecordsByBatchId,
  findFlexWipRecordsByBatchId,
  findRenderwaysRecordsByBatchId,
} from "../../repositories/sourceRecordRepository.js";
import { findUploadBatchesForValidation } from "../../repositories/uploadBatchRepository.js";
import {
  findActiveSlaHoursByCategory,
  findAreaNameByPincode,
} from "../../repositories/businessRuleRepository.js";
import { findAllowedRegionsForUser } from "../rbac/regionAccessService.js";
import { aspCodesForRegion } from "../rbac/regionRowAccess.js";
import type { AuthenticatedUser } from "../../types/auth.js";
import type {
  DuplicateTrackingSummary,
  EnrichedCallPlanRow,
  MatchedCallPlanRecord,
  MatchStatus,
} from "../../types/matching.js";
import { unprocessableEntity } from "../../utils/httpError.js";
import { matchSourceRecords } from "./matchingEngine.js";
import {
  dedupeRowsByTicket,
  findDuplicateTicketKeys,
  groupRowsByTicket,
} from "../normalization/dedupeRowsByTicket.js";

export interface MatchPreviewInput {
  flexUploadBatchId: string;
  renderwaysUploadBatchId?: string | null | undefined;
  callPlanUploadBatchId?: string | null | undefined;
  currentUser: AuthenticatedUser;
  regionId: string | null;
}

export interface MatchPreviewResult {
  totalRenderwaysRows: number;
  totalFlexRows: number;
  flexMatchedRows: number;
  callPlanMatchedRows: number;
  unmatchedFlexRows: number;
  unmatchedCallPlanRows: number;
  duplicateTracking: DuplicateTrackingSummary;
  matchStatusCounts: Record<MatchStatus, number>;
  enrichedRows: EnrichedCallPlanRow[];
  matches: MatchedCallPlanRecord[];
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

export async function previewMatches(
  input: MatchPreviewInput,
): Promise<MatchPreviewResult> {
  const client = await pool.connect();

  try {
    const batchIds = [
      input.flexUploadBatchId,
      input.renderwaysUploadBatchId,
      input.callPlanUploadBatchId,
    ].filter((batchId): batchId is string => Boolean(batchId));
    const batches = await findUploadBatchesForValidation(client, batchIds);

    if (batches.length !== batchIds.length) {
      const foundBatchIds = new Set(batches.map((batch) => batch.id));
      throw unprocessableEntity("One or more upload batches were not found", {
        missingBatchIds: batchIds.filter((batchId) => !foundBatchIds.has(batchId)),
      });
    }

    // Completed reports are shared, all-region artifacts: every admin restores
    // the same latest session regardless of which region uploaded its batches.
    // So a REGION_ADMIN may PREVIEW any batches, but only ever SEES their own
    // regions' rows — the same scoping filterReportForRegions applies to the
    // generated report. (The old assertCanAccessBatchRegions hard-block here
    // 403'd login restore for every admin whose region wasn't the uploader.)
    const allowedRegions = await findAllowedRegionsForUser(input.currentUser);

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

    const groupedFlexWip = groupRowsByTicket(flexWip);
    const flexWipHeaders = groupedFlexWip.workOrders.map((workOrder) => ({
      ...workOrder.header,
      parts: workOrder.parts,
    }));
    const dedupedRenderways = dedupeRowsByTicket(renderways);
    const dedupedCallPlan = dedupeRowsByTicket(callPlan);

    assertNoResidualDuplicates("Flex WIP", flexWipHeaders);
    assertNoResidualDuplicates("Renderways", dedupedRenderways.dedupedRows);
    assertNoResidualDuplicates("Call Plan", dedupedCallPlan.dedupedRows);

    const duplicateTracking: DuplicateTrackingSummary = {
      flexWip: groupedFlexWip.duplicatePartLineCount,
      renderways: dedupedRenderways.duplicateCount,
      callPlan: dedupedCallPlan.duplicateCount,
      total:
        groupedFlexWip.duplicatePartLineCount +
        dedupedRenderways.duplicateCount +
        dedupedCallPlan.duplicateCount,
    };

    if (duplicateTracking.total > 0) {
      console.info("[matchPreviewService] Removed duplicate rows before matching", duplicateTracking);
    }

    const slaHoursByWipAgingCategory = await findActiveSlaHoursByCategory(client);
    const areaNameByPincode = await findAreaNameByPincode(
      client,
      input.regionId,
    );

    const matches = matchSourceRecords({
      flexWip: flexWipHeaders,
      renderways: dedupedRenderways.dedupedRows,
      callPlan: dedupedCallPlan.dedupedRows,
      slaHoursByWipAgingCategory,
      areaNameByPincode,
    });
    // Region scoping: a REGION_ADMIN sees only their regions' rows; a
    // SUPER_ADMIN (allowedRegions === null) sees everything, counts unchanged.
    let scopedMatches = matches;
    if (allowedRegions) {
      const wantedCodes = new Set<string>();
      for (const region of allowedRegions) {
        for (const code of aspCodesForRegion(region)) {
          wantedCodes.add(code);
        }
      }
      scopedMatches = matches.filter((match) =>
        wantedCodes.has(
          String(match.enrichedRow.work_location ?? "").trim().toUpperCase(),
        ),
      );
    }

    let flexMatchedRows = 0;
    let callPlanMatchedRows = 0;
    const enrichedRows: EnrichedCallPlanRow[] = [];
    const matchStatusCounts: Record<MatchStatus, number> = {
      MATCHED: 0,
      RENDERWAYS_MISSING: 0,
      FLEX_MISSING: 0,
      CALLPLAN_MISSING: 0,
      BOTH_MISSING: 0,
    };

    for (const match of scopedMatches) {
      if (match.flexWip && match.renderways) {
        flexMatchedRows += 1;
      }

      if (match.flexWip && match.callPlan) {
        callPlanMatchedRows += 1;
      }

      matchStatusCounts[match.matchStatus] += 1;
      enrichedRows.push(match.enrichedRow);
    }

    // Totals reflect what the viewer can see: full-file counts for a
    // SUPER_ADMIN, the region-scoped counts for a REGION_ADMIN (matching what
    // a region-scoped generation would actually affect).
    const totalFlexRows = allowedRegions
      ? scopedMatches.filter((match) => match.flexWip).length
      : flexWipHeaders.length;
    const totalRenderwaysRows = allowedRegions
      ? scopedMatches.filter((match) => match.renderways).length
      : dedupedRenderways.dedupedRows.length;

    return {
      totalRenderwaysRows,
      totalFlexRows,
      flexMatchedRows,
      callPlanMatchedRows,
      unmatchedFlexRows: scopedMatches.filter((match) => !match.flexWip).length,
      unmatchedCallPlanRows: totalFlexRows - callPlanMatchedRows,
      duplicateTracking,
      matchStatusCounts,
      enrichedRows,
      matches: scopedMatches,
    };
  } finally {
    client.release();
  }
}
