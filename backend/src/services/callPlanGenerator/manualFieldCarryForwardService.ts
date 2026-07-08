import type { ReportRowComparisonInsight } from "@opencall/shared";
import type { FinalReportManualCarryForwardRow } from "../../repositories/dailyCallPlanReportRepository.js";
import type { EnrichedCallPlanRow, MatchedCallPlanRecord } from "../../types/matching.js";
import type {
  GeneratedDailyCallPlanRow,
  ManualCarryForwardField,
  ManualCarryForwardRowMetadata,
  ManualCarryForwardSummary,
} from "../../types/reportGeneration.js";
import {
  MANUAL_CARRY_FORWARD_FIELDS,
  OPTIONAL_MANUAL_CARRY_FORWARD_FIELDS,
} from "../../types/reportGeneration.js";
import { getNormalizedTicketKey } from "../normalization/dedupeRowsByTicket.js";
import {
  formatDailyCallPlanRow,
  MANUAL_ENTRY_REQUIRED,
  orderedDailyCallPlanRow,
} from "./dailyCallPlanFormatter.js";

const PLACEHOLDER_VALUES = new Set([
  "",
  MANUAL_ENTRY_REQUIRED.toLowerCase(),
  "n/a",
  "na",
  "not applicable",
  "not available",
  "none",
  "null",
  "undefined",
  "-",
  "--",
]);

export interface ApplyManualFieldCarryForwardInput {
  currentRows: readonly GeneratedDailyCallPlanRow[];
  previousFinalRows: readonly FinalReportManualCarryForwardRow[];
  /**
   * The report date being generated (YYYY-MM-DD). Used to decide whether the
   * carry-forward source is from a PRIOR day (promote Evening→Morning, clear
   * Evening) or the SAME day (keep Morning baseline, preserve Evening work).
   */
  currentReportDate: string;
}

export interface ApplyManualFieldCarryForwardResult {
  rows: GeneratedDailyCallPlanRow[];
  summary: ManualCarryForwardSummary;
}

type MutableManualFieldValues = Pick<
  EnrichedCallPlanRow,
  ManualCarryForwardField
>;

const ALL_CARRY_FORWARD_FIELDS: readonly ManualCarryForwardField[] = [
  ...MANUAL_CARRY_FORWARD_FIELDS,
  ...OPTIONAL_MANUAL_CARRY_FORWARD_FIELDS,
];

export function cleanManualValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const cleaned = String(value).trim().replace(/\s+/g, " ");
  if (PLACEHOLDER_VALUES.has(cleaned.toLowerCase())) {
    return null;
  }

  return cleaned;
}

function hasManualValue(value: unknown): boolean {
  return cleanManualValue(value) !== null;
}

function defaultCarryForwardMetadata(
  overrides?: Partial<ManualCarryForwardRowMetadata>,
): ManualCarryForwardRowMetadata {
  return {
    carriedForwardFields: [],
    manualFieldsCompleted: false,
    manualFieldsMissing: [...MANUAL_CARRY_FORWARD_FIELDS],
    changeType: null,
    previousTicketMatched: false,
    closedSyntheticRow: false,
    ...overrides,
  };
}

function previousRowsByTicket(
  rows: readonly FinalReportManualCarryForwardRow[],
): Map<string, FinalReportManualCarryForwardRow> {
  const previousByTicket = new Map<string, FinalReportManualCarryForwardRow>();

  for (const row of rows) {
    const ticketKey = getNormalizedTicketKey(row.ticketId);
    if (!ticketKey || previousByTicket.has(ticketKey)) {
      continue;
    }

    previousByTicket.set(ticketKey, row);
  }

  return previousByTicket;
}

function currentFieldValue(
  row: EnrichedCallPlanRow,
  field: ManualCarryForwardField,
): string | null {
  return cleanManualValue(row[field]);
}

function previousFieldValue(
  row: FinalReportManualCarryForwardRow,
  field: ManualCarryForwardField,
): string | null {
  return cleanManualValue(row.manualValues[field]);
}

function assignManualField(
  row: EnrichedCallPlanRow,
  field: ManualCarryForwardField,
  value: string,
): void {
  const mutableRow = row as EnrichedCallPlanRow & MutableManualFieldValues;

  mutableRow[field] = value;
}

function missingManualFields(
  row: EnrichedCallPlanRow,
): ManualCarryForwardField[] {
  return MANUAL_CARRY_FORWARD_FIELDS.filter(
    (field) => !hasManualValue(row[field]),
  );
}

function closedRowToEnriched(
  row: FinalReportManualCarryForwardRow,
): EnrichedCallPlanRow {
  return {
    ticket_id: row.ticketId,
    case_id: row.caseId ?? "",
    case_created_time: row.caseCreatedTime,
    wip_aging: row.wipAging,
    rtpl_status: previousFieldValue(row, "rtpl_status") ?? "",
    segment: previousFieldValue(row, "segment") ?? "",
    engineer: previousFieldValue(row, "engineer"),
    product: row.product,
    product_line_name: row.productLineName,
    work_location: row.workLocation,
    flex_status: row.flexStatus,
    status_aging: previousFieldValue(row, "status_aging"),
    current_status_aging: null,
    hp_owner_status: row.hpOwnerStatus,
    wo_otc_code: row.woOtcCode,
    account_name: row.accountName,
    customer_name: row.customerName,
    // Closed synthetic rows are excluded from the active dashboard, so customer
    // type is not carried forward from the persisted final report.
    customer_type: null,
    location: previousFieldValue(row, "location"),
    contact: row.contact,
    part: row.part,
    product_serial_no: null,
    wip_aging_category: row.wipAgingCategory,
    tat: row.tat,
    customer_mail: previousFieldValue(row, "customer_mail"),
    rca: previousFieldValue(row, "rca"),
    remarks: previousFieldValue(row, "remarks"),
    manual_notes: previousFieldValue(row, "manual_notes"),
    match_status: "BOTH_MISSING",
  };
}

function closedSyntheticMatch(enriched: EnrichedCallPlanRow): MatchedCallPlanRecord {
  return {
    renderways: null,
    flexWip: null,
    callPlan: null,
    flexMatchConfidence: "UNMATCHED",
    callPlanMatchConfidence: "UNMATCHED",
    matchStatus: "BOTH_MISSING",
    enrichedRow: enriched,
    notes: ["Ticket existed in the previous final report but is absent today"],
  };
}

function closedComparisonInsight(
  previous: FinalReportManualCarryForwardRow,
): ReportRowComparisonInsight {
  return {
    changeType: "CLOSED",
    previousFlexStatus: previous.flexStatus,
    previousRtplStatus: previous.rtplStatus,
    previousWipAging: previous.wipAging,
    changedFields: {},
    changeSummary: "Ticket closed",
    flexStatusUnchangedDays: previous.flexStatusUnchangedDays,
  };
}

function reformatRow(row: GeneratedDailyCallPlanRow, serialNo: number): GeneratedDailyCallPlanRow {
  return {
    ...row,
    serialNo,
    output: orderedDailyCallPlanRow(
      formatDailyCallPlanRow(serialNo, row.enriched),
    ),
  };
}

export class ManualFieldCarryForwardService {
  apply(
    input: ApplyManualFieldCarryForwardInput,
  ): ApplyManualFieldCarryForwardResult {
    const previousByTicket = previousRowsByTicket(input.previousFinalRows);
    const currentTicketKeys = new Set<string>();
    let totalFieldsCarried = 0;
    let rowsAutoCompleted = 0;
    let rowsStillManual = 0;

    const mergedRows = input.currentRows.map((row) => {
      const ticketKey = getNormalizedTicketKey(row.enriched.ticket_id);
      if (ticketKey) {
        currentTicketKeys.add(ticketKey);
      }

      const previousRow = ticketKey ? previousByTicket.get(ticketKey) ?? null : null;
      const enriched: EnrichedCallPlanRow = { ...row.enriched };
      const carriedForwardFields: ManualCarryForwardField[] = [];

      if (previousRow) {
        for (const field of ALL_CARRY_FORWARD_FIELDS) {
          // Segment is deterministically derived from the FieldEZ file every
          // run (see getSegment). It must never be carried from a previous
          // report, or a stale/misclassified value freezes forever (e.g. a
          // "Trade Print" reverting to warranty "Print", or a raw "MPS").
          if (field === "segment") {
            continue;
          }
          // rtpl_status is the Morning (BOD) column; it and the Evening (EOD)
          // status follow the day-boundary promotion rules below, not the
          // generic fill.
          if (field === "rtpl_status") {
            continue;
          }
          if (currentFieldValue(enriched, field)) {
            continue;
          }

          const previousValue = previousFieldValue(previousRow, field);
          if (!previousValue) {
            continue;
          }

          assignManualField(enriched, field, previousValue);
          carriedForwardFields.push(field);
        }

        // Morning / Evening day-boundary promotion. Fresh generated rows always
        // arrive with a blank Morning here; for existing reports the persisted
        // Morning/Evening are restored later (applyPersistedRowMetadata), which
        // overrides this.
        if (!currentFieldValue(enriched, "rtpl_status")) {
          const sourceMorning = cleanManualValue(previousRow.rtplStatus);
          const sourceEvening = cleanManualValue(previousRow.eveningRtplStatus);
          const sourceIsPriorDay =
            !previousRow.sourceReportDate ||
            previousRow.sourceReportDate < input.currentReportDate;

          if (sourceIsPriorDay) {
            // New day: yesterday's Evening becomes today's Morning (fall back to
            // yesterday's Morning if Evening was left blank); Evening starts empty.
            const promotedMorning = sourceEvening ?? sourceMorning;
            if (promotedMorning) {
              assignManualField(enriched, "rtpl_status", promotedMorning);
              carriedForwardFields.push("rtpl_status");
            }
            enriched.evening_rtpl_status = null;
          } else {
            // Same-day re-upload: keep the Morning baseline and preserve the
            // Evening work entered earlier today.
            if (sourceMorning) {
              assignManualField(enriched, "rtpl_status", sourceMorning);
              carriedForwardFields.push("rtpl_status");
            }
            enriched.evening_rtpl_status = sourceEvening;
          }
        }
      }

      const manualFieldsMissing = missingManualFields(enriched);
      totalFieldsCarried += carriedForwardFields.length;

      if (manualFieldsMissing.length > 0) {
        rowsStillManual += 1;
      } else if (carriedForwardFields.length > 0) {
        rowsAutoCompleted += 1;
      }

      const carryForward = defaultCarryForwardMetadata({
        carriedForwardFields,
        manualFieldsCompleted: manualFieldsMissing.length === 0,
        manualFieldsMissing,
        changeType: previousRow
          ? carriedForwardFields.length > 0
            ? "CARRIED"
            : null
          : "NEW_WORK_ORDER",
        previousTicketMatched: Boolean(previousRow),
      });

      return {
        ...row,
        enriched,
        match: {
          ...row.match,
          enrichedRow: enriched,
        },
        carryForward,
      };
    });

    for (const [ticketKey, previousRow] of previousByTicket.entries()) {
      if (currentTicketKeys.has(ticketKey)) {
        continue;
      }

      const enriched = closedRowToEnriched(previousRow);
      const match = closedSyntheticMatch(enriched);

      mergedRows.push({
        id: null,
        serialNo: mergedRows.length + 1,
        enriched,
        match,
        comparison: closedComparisonInsight(previousRow),
        carryForward: defaultCarryForwardMetadata({
          carriedForwardFields: [],
          manualFieldsCompleted: true,
          manualFieldsMissing: [],
          changeType: "CLOSED",
          previousTicketMatched: true,
          closedSyntheticRow: true,
        }),
        updatedAt: null,
        updatedBy: null,
        rowEditable: true,
        carryForwardSource: "PREVIOUS_FINAL_REPORT",
        output: orderedDailyCallPlanRow(
          formatDailyCallPlanRow(mergedRows.length + 1, enriched),
        ),
      });
    }

    return {
      rows: mergedRows.map((row, index) => reformatRow(row, index + 1)),
      summary: {
        totalFieldsCarried,
        rowsAutoCompleted,
        rowsStillManual,
      },
    };
  }
}

export const manualFieldCarryForwardService =
  new ManualFieldCarryForwardService();
