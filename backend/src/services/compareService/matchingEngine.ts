import type {
  EnrichedCallPlanRow,
  MatchedCallPlanInput,
  MatchedCallPlanRecord,
  MatchConfidence,
  MatchStatus,
} from "../../types/matching.js";
import type {
  CallPlanParsedRecord,
  FlexWipParsedRecord,
  RenderwaysParsedRecord,
} from "../../types/sourceRecords.js";
import {
  normalizeCaseId,
  normalizePincode,
  normalizeTicketId,
} from "../normalization/valueNormalizer.js";
import { formatOpenCallPartCell } from "../normalization/dedupeRowsByTicket.js";
import { pickWorkOrderShipmentStatus } from "@opencall/shared";
import {
  calculateTAT,
  getLookupNumber,
  getSegment,
  mapLocation,
} from "./enrichmentHelpers.js";
import { calculateWipAging } from "./wipAgingCalculator.js";
import {
  officeDistance,
  passesPincodeGate,
  type OfficeDistance,
} from "../../utils/geo.js";
import {
  addressRoadDistanceKey,
  roadDistanceKey,
} from "../../repositories/geoRepository.js";
import { parseCustomDate } from "../../utils/dateParser.js";

interface IndexedLookup<TRecord> {
  records: Map<string, TRecord>;
  duplicateKeys: Set<string>;
}

interface MatchResult<TRecord, TConfidence extends MatchConfidence> {
  record: TRecord | null;
  confidence: TConfidence;
  duplicateKey: string | null;
}

function stableRecordRank(record: { rowNumber: number; id?: string }): string {
  return `${String(record.rowNumber).padStart(12, "0")}:${record.id ?? ""}`;
}

function shouldReplaceSelectedRecord<TRecord extends { rowNumber: number; id?: string }>(
  current: TRecord,
  candidate: TRecord,
): boolean {
  return stableRecordRank(candidate) < stableRecordRank(current);
}

function buildSingleRecordLookup<TRecord extends { rowNumber: number; id?: string }>(
  records: readonly TRecord[],
  getKey: (record: TRecord) => string | null,
): IndexedLookup<TRecord> {
  const lookup: IndexedLookup<TRecord> = {
    records: new Map<string, TRecord>(),
    duplicateKeys: new Set<string>(),
  };

  for (const record of records) {
    const key = getKey(record);

    if (!key) {
      continue;
    }

    const current = lookup.records.get(key);

    if (!current) {
      lookup.records.set(key, record);
      continue;
    }

    lookup.duplicateKeys.add(key);

    if (shouldReplaceSelectedRecord(current, record)) {
      lookup.records.set(key, record);
    }
  }

  return lookup;
}

function canonicalTicketKey(
  record: Pick<FlexWipParsedRecord | RenderwaysParsedRecord | CallPlanParsedRecord, "ticketId" | "normalizedTicketId">,
): string | null {
  const key = normalizeTicketId(record.ticketId ?? record.normalizedTicketId);
  return key.length > 0 ? key : null;
}

function canonicalCaseKey(
  record: Pick<FlexWipParsedRecord | RenderwaysParsedRecord, "caseId" | "normalizedCaseId">,
): string | null {
  const key = normalizeCaseId(record.caseId ?? record.normalizedCaseId);
  return key.length > 0 ? key : null;
}

function findFlexMatch(
  renderways: RenderwaysParsedRecord,
  flexByTicket: IndexedLookup<FlexWipParsedRecord>,
  flexByCase: IndexedLookup<FlexWipParsedRecord>,
): MatchResult<FlexWipParsedRecord, MatchConfidence> {
  const ticketKey = canonicalTicketKey(renderways);

  if (ticketKey) {
    const ticketMatch = flexByTicket.records.get(ticketKey);

    if (ticketMatch) {
      return {
        record: ticketMatch,
        confidence: "TICKET_ID",
        duplicateKey: flexByTicket.duplicateKeys.has(ticketKey) ? ticketKey : null,
      };
    }
  }

  const caseKey = canonicalCaseKey(renderways);

  if (caseKey) {
    const caseMatch = flexByCase.records.get(caseKey);

    if (caseMatch) {
      return {
        record: caseMatch,
        confidence: "CASE_ID",
        duplicateKey: flexByCase.duplicateKeys.has(caseKey) ? caseKey : null,
      };
    }
  }

  return {
    record: null,
    confidence: "UNMATCHED",
    duplicateKey: null,
  };
}

function findRenderwaysMatch(
  flexWip: FlexWipParsedRecord,
  renderwaysByTicket: IndexedLookup<RenderwaysParsedRecord>,
  renderwaysByCase: IndexedLookup<RenderwaysParsedRecord>,
): MatchResult<RenderwaysParsedRecord, MatchConfidence> {
  const ticketKey = canonicalTicketKey(flexWip);

  if (ticketKey) {
    const ticketMatch = renderwaysByTicket.records.get(ticketKey);

    if (ticketMatch) {
      return {
        record: ticketMatch,
        confidence: "TICKET_ID",
        duplicateKey: renderwaysByTicket.duplicateKeys.has(ticketKey) ? ticketKey : null,
      };
    }
  }

  const caseKey = canonicalCaseKey(flexWip);

  if (caseKey) {
    const caseMatch = renderwaysByCase.records.get(caseKey);

    if (caseMatch) {
      return {
        record: caseMatch,
        confidence: "CASE_ID",
        duplicateKey: renderwaysByCase.duplicateKeys.has(caseKey) ? caseKey : null,
      };
    }
  }

  return {
    record: null,
    confidence: "UNMATCHED",
    duplicateKey: null,
  };
}

function findCallPlanMatch(
  ticketKey: string | null,
  callPlanByTicket: IndexedLookup<CallPlanParsedRecord>,
): MatchResult<CallPlanParsedRecord, Exclude<MatchConfidence, "CASE_ID">> {
  if (!ticketKey) {
    return {
      record: null,
      confidence: "UNMATCHED",
      duplicateKey: null,
    };
  }

  const match = callPlanByTicket.records.get(ticketKey);

  return match
    ? {
        record: match,
        confidence: "TICKET_ID",
        duplicateKey: callPlanByTicket.duplicateKeys.has(ticketKey)
          ? ticketKey
          : null,
      }
    : {
        record: null,
        confidence: "UNMATCHED",
        duplicateKey: null,
      };
}

function classifyMatchStatus(
  flexWip: FlexWipParsedRecord | null,
  callPlan: CallPlanParsedRecord | null,
): MatchStatus {
  if (flexWip && callPlan) {
    return "MATCHED";
  }

  if (!flexWip && !callPlan) {
    return "BOTH_MISSING";
  }

  return flexWip ? "CALLPLAN_MISSING" : "FLEX_MISSING";
}

function toIsoString(value: Date | string | null | undefined): string | null {
  const parsed = parseCustomDate(value);
  return parsed ? parsed.toISOString() : null;
}

/**
 * OpenCall "Part" cell for a work order: the `" / "`-joined RCV_SPARE part
 * descriptions plus a muted in-transit count. Uses the grouped `parts[]`
 * attached to the Flex header when present; falls back to the single
 * `partDescription` for ungrouped/Renderways-only rows.
 */
function buildPartCell(flexWip: FlexWipParsedRecord | null): string | null {
  if (!flexWip) {
    return null;
  }

  const parts = flexWip.parts;
  if (parts && parts.length > 0) {
    const cell = formatOpenCallPartCell(parts);
    return cell.length > 0 ? cell : flexWip.partDescription ?? null;
  }

  return flexWip.partDescription ?? null;
}

function buildEnrichedRow(
  renderways: RenderwaysParsedRecord | null,
  flexWip: FlexWipParsedRecord | null,
  callPlan: CallPlanParsedRecord | null,
  matchStatus: MatchStatus,
  input: MatchedCallPlanInput,
): EnrichedCallPlanRow {
  const slaHours = getLookupNumber(
    input.slaHoursByWipAgingCategory,
    renderways?.wipAgingCategory,
  );
  const caseCreatedTime = toIsoString(flexWip?.createTime);
  const calculatedWipAging = calculateWipAging(caseCreatedTime);
  const officeDistanceForRow = resolveOfficeDistance(flexWip, input);

  return {
    ticket_id: flexWip?.ticketId ?? renderways?.ticketId ?? callPlan?.ticketId ?? "",
    case_id: flexWip?.caseId ?? renderways?.caseId ?? "",
    case_created_time: caseCreatedTime,
    wip_aging: renderways?.wipAging ?? calculatedWipAging ?? null,
    rtpl_status: renderways?.rtplStatus ?? callPlan?.morningStatus ?? "",
    segment: getSegment(flexWip?.businessSegment, flexWip?.woOtcCode),
    engineer: callPlan?.engineer ?? null,
    product: flexWip?.product ?? null,
    product_line_name: flexWip?.productLineName ?? null,
    work_location: flexWip?.workLocation ?? null,
    flex_status: flexWip?.flexStatus ?? null,
    status_aging: renderways?.wipChangedFromMorningReport ?? null,
    current_status_aging: renderways?.currentStatusAging ?? null,
    hp_owner_status: renderways?.hpOwner ?? null,
    wo_otc_code: flexWip?.woOtcCode ?? null,
    account_name: flexWip?.accountName ?? null,
    customer_name: flexWip?.customerName ?? null,
    customer_type: renderways?.customerType ?? null,
    location: callPlan?.location ?? mapLocation(flexWip?.customerPincode, input.areaNameByPincode),
    // Derived from the PINCODE, not from `location`. The Location cell is a
    // manually editable carry-forward field, so keying distance off it would let
    // an edited label silently desync the kilometres from the actual place.
    distance_km: officeDistanceForRow?.distanceKm ?? null,
    distance_bearing: officeDistanceForRow?.bearing ?? null,
    distance_is_routed: officeDistanceForRow?.routed ?? false,
    contact: flexWip?.contact ?? null,
    part: buildPartCell(flexWip),
    // Transient: the most-blocking part-shipment status, used only to derive
    // the auto-RCA ETA at generation. Not persisted (see EnrichedCallPlanRow).
    part_shipment_status: pickWorkOrderShipmentStatus(flexWip?.parts ?? null),
    product_serial_no: flexWip?.productSerialNo ?? null,
    wip_aging_category: renderways?.wipAgingCategory ?? null,
    tat: calculateTAT(renderways?.partnerAccept, slaHours),
    customer_mail: flexWip?.customerEmail ?? null,
    rca: renderways?.rcaMessage ?? null,
    remarks: null,
    manual_notes: null,
    match_status: matchStatus,
  };
}

/**
 * Distance and direction from the branch office that owns this call to the
 * customer — the geocoded ADDRESS when one is available, routed and sane,
 * otherwise the pincode centroid.
 *
 * The origin is chosen by the row's own Work Location (the ASP code), not by the
 * report's region: a Chennai work order raised against a Vellore address must
 * report its real 110km, because that distance is exactly what makes the
 * misfiling visible. Suppressing it would hide the problem behind a blank cell.
 *
 * The exact-address tier engages only when ALL THREE hold, each load-bearing:
 *  - the ticket has a provider geocode (not a centroid re-statement);
 *  - that coordinate passes the pincode sanity gate — a geocoder answers the
 *    written address, and one measured row's address sits 85 km from the site;
 *  - its ROAD distance is already computed. Without it the tier would swap a
 *    routed centroid figure for a straight-line guess: a better coordinate but
 *    a worse number, so the row waits on the pincode tier instead.
 *
 * Exported for its tests; production callers go through matchSourceRecords.
 */
export function resolveOfficeDistance(
  flexWip: FlexWipParsedRecord | null,
  input: MatchedCallPlanInput,
): { distanceKm: number; bearing: string; routed: boolean } | null {
  if (!input.officeByAspCode || !input.coordinatesByPincode) {
    return null;
  }

  const aspCode = (flexWip?.workLocation ?? "").trim().toUpperCase();
  const pincode = normalizePincode(flexWip?.customerPincode);
  if (!aspCode || !pincode) {
    return null;
  }

  const office = input.officeByAspCode.get(aspCode);
  const centroid = input.coordinatesByPincode.get(pincode);

  const ticketKey = normalizeTicketId(flexWip?.ticketId);
  const precise = ticketKey ? input.preciseCoordByTicketId?.get(ticketKey) : undefined;
  if (office && precise && centroid && passesPincodeGate(precise, centroid)) {
    const addressRoutedKm = input.roadDistanceByOfficeAddress?.get(
      addressRoadDistanceKey(aspCode, precise.addressKey),
    );
    if (addressRoutedKm != null) {
      const preciseGeometry = officeDistance(office, precise);
      if (preciseGeometry) {
        return {
          distanceKm: addressRoutedKm,
          bearing: preciseGeometry.bearing,
          routed: true,
        };
      }
    }
    // No route for this address yet — fall through to the pincode tier.
  }

  const geometry: OfficeDistance | null = officeDistance(office, centroid);
  if (!geometry) {
    return null;
  }

  // Prefer the routed distance. The straight-line estimate is only a stand-in
  // until this pincode has been routed: measured over the live Chennai set it
  // misses by 5.2km on average, because the real road/straight ratio varies from
  // 1.11 to 1.94 with the character of the route.
  const routedKm = input.roadDistanceByOfficePincode?.get(
    roadDistanceKey(aspCode, pincode),
  );

  return routedKm == null
    ? { distanceKm: geometry.distanceKm, bearing: geometry.bearing, routed: false }
    : { distanceKm: routedKm, bearing: geometry.bearing, routed: true };
}

function buildMatchNotes(
  renderwaysMatch: MatchResult<RenderwaysParsedRecord, MatchConfidence>,
  callPlanMatch: MatchResult<
    CallPlanParsedRecord,
    Exclude<MatchConfidence, "CASE_ID">
  >,
  flexWip: FlexWipParsedRecord,
): string[] {
  const notes: string[] = [];

  if (renderwaysMatch.confidence === "UNMATCHED") {
    notes.push("No Renderways match found by Ticket ID or Case ID");
  }

  if (callPlanMatch.confidence === "UNMATCHED") {
    notes.push("No Call Plan match found by Ticket ID");
  }

  if (renderwaysMatch.duplicateKey) {
    notes.push(
      `Multiple Renderways rows found for ${renderwaysMatch.confidence}: ${renderwaysMatch.duplicateKey}; selected lowest row number`,
    );
  }

  if (callPlanMatch.duplicateKey) {
    notes.push(
      `Multiple Call Plan rows found for Ticket ID: ${callPlanMatch.duplicateKey}; selected lowest row number`,
    );
  }

  if (!canonicalTicketKey(flexWip) && flexWip.normalizedCaseId) {
    notes.push("Call Plan lookup skipped because Flex WIP Ticket ID is missing");
  }

  return notes;
}

export function matchSourceRecords(
  input: MatchedCallPlanInput,
): MatchedCallPlanRecord[] {
  const flexByTicket = buildSingleRecordLookup(input.flexWip, canonicalTicketKey);
  const flexByCase = buildSingleRecordLookup(input.flexWip, canonicalCaseKey);
  const renderwaysByTicket = buildSingleRecordLookup(
    input.renderways,
    canonicalTicketKey,
  );
  const renderwaysByCase = buildSingleRecordLookup(
    input.renderways,
    canonicalCaseKey,
  );
  const callPlanByTicket = buildSingleRecordLookup(
    input.callPlan,
    canonicalTicketKey,
  );
  const matchedRecords: MatchedCallPlanRecord[] = [];

  for (const flexWip of input.flexWip) {
    const renderwaysMatch = findRenderwaysMatch(
      flexWip,
      renderwaysByTicket,
      renderwaysByCase,
    );
    const callPlanTicketKey = canonicalTicketKey(flexWip);
    const callPlanMatch = findCallPlanMatch(callPlanTicketKey, callPlanByTicket);
    const matchStatus: MatchStatus =
      renderwaysMatch.record && callPlanMatch.record
        ? "MATCHED"
        : renderwaysMatch.record
          ? "CALLPLAN_MISSING"
          : "RENDERWAYS_MISSING";

    matchedRecords.push({
      renderways: renderwaysMatch.record,
      flexWip,
      callPlan: callPlanMatch.record,
      flexMatchConfidence: "TICKET_ID",
      callPlanMatchConfidence: callPlanMatch.confidence,
      matchStatus,
      enrichedRow: buildEnrichedRow(
        renderwaysMatch.record,
        flexWip,
        callPlanMatch.record,
        matchStatus,
        input,
      ),
      notes: buildMatchNotes(
        renderwaysMatch,
        callPlanMatch,
        flexWip,
      ),
    });
  }

  const matchedFlexIds = new Set(
    matchedRecords.map((match) => match.flexWip?.id ?? stableRecordRank(match.flexWip!)),
  );

  for (const renderways of input.renderways) {
    const flexMatch = findFlexMatch(renderways, flexByTicket, flexByCase);

    if (flexMatch.record) {
      const flexId = flexMatch.record.id ?? stableRecordRank(flexMatch.record);

      if (matchedFlexIds.has(flexId)) {
        continue;
      }
    }

    const renderwaysTicketKey = canonicalTicketKey(renderways);
    const callPlanMatch = findCallPlanMatch(renderwaysTicketKey, callPlanByTicket);

    matchedRecords.push({
      renderways,
      flexWip: null,
      callPlan: callPlanMatch.record,
      flexMatchConfidence: flexMatch.confidence,
      callPlanMatchConfidence: callPlanMatch.confidence,
      matchStatus: classifyMatchStatus(null, callPlanMatch.record),
      enrichedRow: buildEnrichedRow(
        renderways,
        null,
        callPlanMatch.record,
        classifyMatchStatus(null, callPlanMatch.record),
        input,
      ),
      notes: [
        "Renderways row did not match the primary Flex WIP dataset and is excluded from Flex-first reports",
      ],
    });
  }

  return matchedRecords;
}
