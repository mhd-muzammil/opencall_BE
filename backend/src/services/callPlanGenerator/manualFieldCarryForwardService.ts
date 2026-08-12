import type { ReportRowComparisonInsight } from "@opencall/shared";
import type {
  FinalReportManualCarryForwardRow,
  SameDayUserSetEveningRow,
} from "../../repositories/dailyCallPlanReportRepository.js";
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
import { buildAutoRca, isPartCaseText } from "@opencall/shared";
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
  /**
   * Work-location ASP codes (upper-cased) this generation may affect; null =
   * unrestricted. Previous-report tickets outside the scope are never closed by
   * absence: active ones are carried forward verbatim as retained rows, closed
   * ones stay closed under the usual same-day rules. The caller has already
   * dropped out-of-scope rows from currentRows.
   */
  allowedWorkLocations?: ReadonlySet<string> | null;
  /**
   * Same-day Evening authority: for each ticket, the user's most recent
   * NON-BLANK Evening entry across ALL of today's reports (see
   * buildSameDayEveningAuthority). previousFinalRows come from only ONE
   * report (LIMIT 1), and with multiple reports per day (each upload — incl.
   * the FieldEZ worker's — creates one) the Evening a user entered on a
   * different same-day report is invisible there; without this it vanished
   * from every later report. Null/absent = no same-day user-set Evenings
   * (e.g. the day's first upload) — behaviour is byte-identical to before.
   */
  sameDayEveningAuthority?: ReadonlyMap<string, SameDayEveningAuthorityEntry> | null;
}

export interface SameDayEveningAuthorityEntry {
  /** Cleaned, non-blank Evening value (never null). */
  eveningRtplStatus: string;
  /** When the Evening edit holding this value was made (pg text). */
  eveningUpdatedAt: string;
}

/**
 * Collapses the user-touched Evening rows (ordered most-recently-edited
 * first) into one entry per normalized ticket — the user's newest same-day
 * Evening state. Placeholder values ("N/A", "-", …) are dropped.
 */
export function buildSameDayEveningAuthority(
  rows: readonly SameDayUserSetEveningRow[],
): Map<string, SameDayEveningAuthorityEntry> {
  const authority = new Map<string, SameDayEveningAuthorityEntry>();

  for (const row of rows) {
    const ticketKey = getNormalizedTicketKey(row.ticketId);
    const evening = cleanManualValue(row.eveningRtplStatus);
    if (!ticketKey || !evening || authority.has(ticketKey)) {
      continue;
    }
    authority.set(ticketKey, {
      eveningRtplStatus: evening,
      eveningUpdatedAt: row.eveningUpdatedAt,
    });
  }

  return authority;
}

function parseDbTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The effective same-day Evening for a source row: the row's own value,
 * unless the same-day authority holds a NEWER user-set Evening for the
 * ticket (entered on another of today's reports that the LIMIT-1 source
 * missed). A source row whose EVENING was edited at-or-after the authority
 * entry speaks for itself — including an explicit clear — so a deliberately
 * blanked Evening is never resurrected from an older report.
 *
 * Both sides compare Evening edit times, never the whole-row updated_at: that
 * is stamped by every field edit, so changing only the Engineer on a row whose
 * Evening was blank looked exactly like a deliberate clear and wiped the
 * Evening a colleague had just typed on another of today's reports.
 */
function sameDaySourceEvening(
  previousRow: FinalReportManualCarryForwardRow,
  authority: ReadonlyMap<string, SameDayEveningAuthorityEntry> | null | undefined,
): string | null {
  const sourceEvening = cleanManualValue(previousRow.eveningRtplStatus);
  const ticketKey = getNormalizedTicketKey(previousRow.ticketId);
  const entry = ticketKey ? authority?.get(ticketKey) : undefined;
  if (!entry) {
    return sourceEvening;
  }

  const sourceEditedAt = parseDbTimestamp(previousRow.eveningUpdatedAt);
  const authorityEditedAt = parseDbTimestamp(entry.eveningUpdatedAt);
  if (
    sourceEditedAt !== null &&
    authorityEditedAt !== null &&
    sourceEditedAt >= authorityEditedAt
  ) {
    return sourceEvening;
  }

  return entry.eveningRtplStatus;
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
    sameDayClosedRow: false,
    regionScopeRetainedRow: false,
    ...overrides,
  };
}

/**
 * Is this work location inside the generation's region scope? A null scope means
 * unrestricted. A blank work location is out of scope when a scope is set — a
 * region-scoped upload must not create or close calls it cannot attribute to one
 * of its regions.
 */
function isWorkLocationInScope(
  workLocation: string | null | undefined,
  allowedWorkLocations: ReadonlySet<string> | null | undefined,
): boolean {
  if (!allowedWorkLocations) {
    return true;
  }

  const aspCode = (workLocation ?? "").trim().toUpperCase();
  return aspCode.length > 0 && allowedWorkLocations.has(aspCode);
}

/**
 * Was the carry-forward source report uploaded on an earlier day than the one being
 * generated? True for the day's FIRST upload (source = a previous day's report), false
 * for every same-day re-upload (source = an earlier report from today).
 */
function sourceIsPriorDay(
  previousRow: FinalReportManualCarryForwardRow,
  currentReportDate: string,
): boolean {
  return (
    !previousRow.sourceReportDate ||
    previousRow.sourceReportDate < currentReportDate
  );
}

/**
 * A ticket absent from today's Flex WIP is always closed. This decides whether it also
 * stays on the Records page for the rest of the day:
 *
 *  - first upload of the day  -> false: it drops off Records immediately (the original
 *                                behaviour, and the day-boundary that finally removes
 *                                yesterday's same-day closures).
 *  - same-day re-upload, ticket was still active this morning
 *                            -> true: it closed mid-day, so it stays listed on Records
 *                               until tomorrow's first upload.
 *  - same-day re-upload, ticket was already closed
 *                            -> inherit, so a row closed by upload #1 stays off Records
 *                               and one closed by upload #2 stays on it through #3, #4…
 */
function isSameDayClosure(
  previousRow: FinalReportManualCarryForwardRow,
  currentReportDate: string,
): boolean {
  if (sourceIsPriorDay(previousRow, currentReportDate)) {
    return false;
  }

  return previousRow.changeType === "CLOSED"
    ? previousRow.sameDayClosed
    : true;
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
  currentReportDate: string,
  eveningAuthority?: ReadonlyMap<string, SameDayEveningAuthorityEntry> | null,
): EnrichedCallPlanRow {
  return {
    ticket_id: row.ticketId,
    case_id: row.caseId ?? "",
    case_created_time: row.caseCreatedTime,
    wip_aging: row.wipAging,
    // A closed row is off the dispatch board, so distance is not carried
    // forward — nobody is choosing whether to drive to it.
    distance_km: null,
    distance_bearing: null,
    distance_is_routed: false,
    // A same-day closure keeps the Evening entered earlier today (e.g.
    // "Case-Closed") — the closed row stays on the Records page all day, and a
    // blank Evening there misreads as unfinished EOD work. The same-day value
    // comes through the Evening authority so an entry made on another of
    // today's reports survives too. A prior-day closure starts blank: Evening
    // is per-day, so yesterday's value must not leak into today's report.
    evening_rtpl_status: sourceIsPriorDay(row, currentReportDate)
      ? null
      : sameDaySourceEvening(row, eveningAuthority),
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
    // A same-day closed row is still shown on the Records page, so it has to keep the
    // Renderways Customer Type or isConsumerCase falls back to its account-name guess
    // and the consumer/commercial split shifts mid-day. Persisted since migration 024;
    // rows written before it carry NULL, exactly as they did before.
    customer_type: row.customerType,
    location: previousFieldValue(row, "location"),
    contact: row.contact,
    part: row.part,
    product_serial_no: row.productSerialNo,
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

/**
 * An out-of-scope ACTIVE row carried into the new report untouched by a
 * region-scoped upload. Same reconstruction as a closed row, but it stays an open
 * call, so the Morning/Evening day-boundary promotion applies exactly as it does
 * for matched rows: on a new day yesterday's Evening becomes today's Morning and
 * Evening resets; on a same-day re-upload both are preserved.
 */
function retainedRowToEnriched(
  row: FinalReportManualCarryForwardRow,
  currentReportDate: string,
  eveningAuthority?: ReadonlyMap<string, SameDayEveningAuthorityEntry> | null,
): EnrichedCallPlanRow {
  const enriched = closedRowToEnriched(row, currentReportDate, eveningAuthority);
  const sourceMorning = cleanManualValue(row.rtplStatus);
  const sourceEvening = cleanManualValue(row.eveningRtplStatus);

  if (sourceIsPriorDay(row, currentReportDate)) {
    enriched.rtpl_status = sourceEvening ?? sourceMorning ?? "";
    enriched.evening_rtpl_status = null;
  } else {
    enriched.rtpl_status = sourceMorning ?? "";
    enriched.evening_rtpl_status = sameDaySourceEvening(row, eveningAuthority);
  }

  return enriched;
}

function retainedSyntheticMatch(enriched: EnrichedCallPlanRow): MatchedCallPlanRecord {
  return {
    renderways: null,
    flexWip: null,
    callPlan: null,
    flexMatchConfidence: "UNMATCHED",
    callPlanMatchConfidence: "UNMATCHED",
    matchStatus: "BOTH_MISSING",
    enrichedRow: enriched,
    notes: [
      "Outside the uploader's region scope: carried forward unchanged from the previous final report",
    ],
  };
}

function retainedComparisonInsight(
  previous: FinalReportManualCarryForwardRow,
): ReportRowComparisonInsight {
  return {
    changeType: "CARRIED",
    previousFlexStatus: previous.flexStatus,
    previousRtplStatus: previous.rtplStatus,
    previousWipAging: previous.wipAging,
    changedFields: {},
    changeSummary: "Outside the uploader's region scope: carried forward unchanged",
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

        // Morning / Evening day-boundary rules. A fresh row's Morning is NOT
        // always blank here — matchingEngine seeds rtpl_status from the
        // Renderways file / call-plan morningStatus — so the Evening rule must
        // not hide behind the Morning-promotion gate: skipping it silently
        // wiped the same-day Evening work of every file-scheduled row on a
        // re-upload. Morning promotion still only fills a blank Morning; the
        // Evening rule now applies to every matched row. For existing reports
        // the persisted Morning/Evening are restored later
        // (applyPersistedRowMetadata), which overrides this.
        {
          const sourceMorning = cleanManualValue(previousRow.rtplStatus);
          const sourceEvening = cleanManualValue(previousRow.eveningRtplStatus);
          const morningIsBlank = !currentFieldValue(enriched, "rtpl_status");

          if (sourceIsPriorDay(previousRow, input.currentReportDate)) {
            // New day: yesterday's Evening becomes today's Morning (fall back to
            // yesterday's Morning if Evening was left blank); Evening starts empty.
            if (morningIsBlank) {
              const promotedMorning = sourceEvening ?? sourceMorning;
              if (promotedMorning) {
                assignManualField(enriched, "rtpl_status", promotedMorning);
                carriedForwardFields.push("rtpl_status");
              }
            }
            enriched.evening_rtpl_status = null;
          } else {
            // Same-day re-upload: keep the Morning baseline and preserve the
            // Evening work entered earlier today — even when today's files
            // already supplied the Morning. The source value goes through the
            // same-day Evening authority, so an Evening entered on ANOTHER of
            // today's reports (stale tab, FieldEZ-worker churn, in-flight
            // generation race) survives even when the LIMIT-1 source report
            // never saw it.
            if (morningIsBlank && sourceMorning) {
              assignManualField(enriched, "rtpl_status", sourceMorning);
              carriedForwardFields.push("rtpl_status");
            }
            enriched.evening_rtpl_status =
              cleanManualValue(enriched.evening_rtpl_status) ??
              sameDaySourceEvening(previousRow, input.sameDayEveningAuthority);
          }
        }
      } else if (ticketKey && !cleanManualValue(enriched.evening_rtpl_status)) {
        // No carry-forward source row for this ticket, but a user DID set an
        // Evening for it on one of today's reports (the LIMIT-1 source can
        // miss a ticket another same-day report holds). A user-set same-day
        // Evening must never be blanked by a regeneration.
        const authorityEntry = input.sameDayEveningAuthority?.get(ticketKey);
        if (authorityEntry) {
          enriched.evening_rtpl_status = authorityEntry.eveningRtplStatus;
        }
      }

      // Feature B — auto-RCA for a fresh NEW call, written ONCE. Only when the
      // row has no RCA yet, so a Renderways RCA (or, on later edits, a human
      // RCA) always wins. Frozen after today: tomorrow this ticket matches a
      // previous row (CARRIED) and its RCA carries forward unchanged.
      if (!previousRow && !currentFieldValue(enriched, "rca")) {
        const autoRca = buildAutoRca({
          caseCreatedTime: enriched.case_created_time,
          isPartCase: isPartCaseText(enriched.part),
          partText: enriched.part,
          partShipmentStatus: enriched.part_shipment_status ?? null,
          engineer: enriched.engineer,
          todayIso: input.currentReportDate,
        });
        if (autoRca) {
          enriched.rca = autoRca;
          // Mark rca as auto-populated. This makes it (a) persist on a fresh
          // insert, (b) get BACKFILLED into the persisted row when an existing
          // (pre-feature) report is re-opened — via applyPersistedRowMetadata's
          // repair path — so the shown RCA is real and never "disappears" when
          // the row is later edited/scheduled, and (c) carry forward day-to-day
          // as inherited (the write-once/freeze behaviour).
          carriedForwardFields.push("rca");
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

      const inScope = isWorkLocationInScope(
        previousRow.workLocation,
        input.allowedWorkLocations,
      );

      // A region-scoped upload must not close another region's calls: an active
      // out-of-scope ticket absent from (the scope-filtered) current rows is
      // carried forward untouched instead of being closed. Out-of-scope tickets
      // that were ALREADY closed still flow through the closed path below so the
      // ledger keeps them and the same-day rules keep applying.
      if (!inScope && previousRow.changeType !== "CLOSED") {
        const enriched = retainedRowToEnriched(
          previousRow,
          input.currentReportDate,
          input.sameDayEveningAuthority,
        );

        mergedRows.push({
          id: null,
          serialNo: mergedRows.length + 1,
          enriched,
          match: retainedSyntheticMatch(enriched),
          comparison: retainedComparisonInsight(previousRow),
          carryForward: defaultCarryForwardMetadata({
            carriedForwardFields: [],
            manualFieldsCompleted: missingManualFields(enriched).length === 0,
            manualFieldsMissing: missingManualFields(enriched),
            changeType: "CARRIED",
            previousTicketMatched: true,
            regionScopeRetainedRow: true,
          }),
          updatedAt: null,
          updatedBy: null,
          rowEditable: true,
          carryForwardSource: "PREVIOUS_FINAL_REPORT",
          output: orderedDailyCallPlanRow(
            formatDailyCallPlanRow(mergedRows.length + 1, enriched),
          ),
        });
        continue;
      }

      const enriched = closedRowToEnriched(
        previousRow,
        input.currentReportDate,
        input.sameDayEveningAuthority,
      );
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
          sameDayClosedRow: isSameDayClosure(previousRow, input.currentReportDate),
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
