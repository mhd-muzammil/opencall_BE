import type { PartLine } from "../services/normalization/dedupeRowsByTicket.js";

export interface ParsedRowIssue {
  rowNumber: number;
  field: string;
  message: string;
}

export interface ParsedSourceFile<TRecord> {
  records: TRecord[];
  issues: ParsedRowIssue[];
  duplicateNormalizedTicketIds: string[];
  duplicateNormalizedCaseIds: string[];
  duplicateCount: number;
}

export interface FlexWipParsedRecord {
  id?: string;
  ticketId: string;
  normalizedTicketId: string;
  caseId: string | null;
  normalizedCaseId: string | null;
  createTime: Date | null;
  product: string | null;
  flexStatus: string | null;
  woOtcCode: string | null;
  accountName: string | null;
  customerName: string | null;
  contact: string | null;
  customerEmail: string | null;
  partDescription: string | null;
  customerPincode: string | null;
  productLineName: string | null;
  workLocation: string | null;
  productSerialNo: string | null;
  /** FieldEZ "Business Segment" (Computing / Printing). Drives segment classification. */
  businessSegment: string | null;
  // --- Part-level fields (vary row-to-row within a multi-part work order).
  // Derived from the raw Flex WIP row, so optional on ungrouped/legacy shapes. ---
  goodPartNo?: string | null;
  partOrderNo?: string | null;
  soNumber?: string | null;
  /** "RCV_SPARE" (received) | "YTR_INTRANSIT" (ordered) | null (no spare). */
  goodPartInstalledStatus?: string | null;
  partShipmentStatus?: string | null;
  goodPartAwb?: string | null;
  goodPartExpectedDeliveryDate?: string | null;
  goodPartSerialNumber?: string | null;
  /**
   * All distinct part lines for this work order, attached when the flat rows are
   * grouped into a header/detail work order (see `groupRowsByTicket`). Absent on
   * ungrouped rows.
   */
  parts?: PartLine[];
  rawRow: Record<string, unknown>;
  rowNumber: number;
}

export interface RenderwaysParsedRecord {
  id?: string;
  ticketId: string | null;
  normalizedTicketId: string | null;
  caseId: string;
  normalizedCaseId: string;
  partnerAccept: Date | null;
  wipAging: string | null;
  wipAgingCategory: string | null;
  rtplStatus: string | null;
  hpOwner: string | null;
  rcaMessage: string | null;
  productType: string | null;
  callClassification: string | null;
  customerType: string | null;
  wipChangedFromMorningReport: string | null;
  /** Renderways "current status aging" (days) — drives the stale-status banner. */
  currentStatusAging: number | null;
  rawRow: Record<string, unknown>;
  rowNumber: number;
}

export interface CallPlanParsedRecord {
  id?: string;
  ticketId: string;
  normalizedTicketId: string;
  morningStatus: string | null;
  engineer: string | null;
  location: string | null;
  rawRow: Record<string, unknown>;
  rowNumber: number;
}

export type ParsedSourceRecord =
  | FlexWipParsedRecord
  | RenderwaysParsedRecord
  | CallPlanParsedRecord;
