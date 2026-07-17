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
import { assertCanAccessBatchRegions } from "../rbac/regionAccessService.js";
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

    assertCanAccessBatchRegions(input.currentUser, batches);

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

    for (const match of matches) {
      if (match.flexWip && match.renderways) {
        flexMatchedRows += 1;
      }

      if (match.flexWip && match.callPlan) {
        callPlanMatchedRows += 1;
      }

      matchStatusCounts[match.matchStatus] += 1;
      enrichedRows.push(match.enrichedRow);
    }

    return {
      totalRenderwaysRows: dedupedRenderways.dedupedRows.length,
      totalFlexRows: flexWipHeaders.length,
      flexMatchedRows,
      callPlanMatchedRows,
      unmatchedFlexRows: matches.filter((match) => !match.flexWip).length,
      unmatchedCallPlanRows: flexWipHeaders.length - callPlanMatchedRows,
      duplicateTracking,
      matchStatusCounts,
      enrichedRows,
      matches,
    };
  } finally {
    client.release();
  }
}
