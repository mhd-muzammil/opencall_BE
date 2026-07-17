import { cleanString, normalizeTicketId } from "./valueNormalizer.js";

const TIMESTAMP_FIELD_CANDIDATES = [
  "partnerAccept",
  "createTime",
  "caseCreatedTime",
  "case_created_time",
  "tat",
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "timestamp",
] as const;

const COMPLETENESS_METADATA_FIELDS = new Set([
  "id",
  "rowId",
  "rowNumber",
  "ticketId",
  "ticket_id",
  "normalizedTicketId",
  "normalized_ticket_id",
  "rawRow",
  "raw_row",
  "duplicateFlag",
  "duplicate_flag",
]);

export interface TicketDedupeRow {
  ticketId?: string | null;
  ticket_id?: string | null;
  normalizedTicketId?: string | null;
  normalized_ticket_id?: string | null;
  rowNumber: number;
}

export interface DedupeRowsByTicketResult<TRow> {
  dedupedRows: TRow[];
  duplicateCount: number;
}

/**
 * A single spare-part line ordered against a work order. The Flex WIP / ASP
 * report is one-row-per-part, so a multi-part work order contributes one
 * {@link PartLine} per distinct part.
 *
 * `goodPartInstalledStatus` semantics (drive the received/in-transit views):
 * - `"RCV_SPARE"`     → spare physically received (real stock).
 * - `"YTR_INTRANSIT"` → ordered, not yet received.
 * - `null`            → no part line at all (a service call with no spare).
 */
export interface PartLine {
  goodPartNo: string | null;
  partDescription: string | null;
  partOrderNo: string | null;
  soNumber: string | null;
  goodPartInstalledStatus: string | null;
  partShipmentStatus: string | null;
  goodPartAwb: string | null;
  goodPartExpectedDeliveryDate: string | null;
  goodPartSerialNumber: string | null;
}

/**
 * Header/detail view of a work order: one chosen header row (the WO-level
 * fields) plus every distinct part line ordered against it.
 */
export interface GroupedWorkOrder<THeader> {
  /** Canonical work-order key from {@link normalizeTicketKey}. */
  ticketKey: string;
  /** WO-level fields, chosen once via the existing dedupe ranking. */
  header: THeader;
  /** All distinct part lines, deduped on (ticketKey + goodPartNo + partOrderNo). */
  parts: PartLine[];
}

export interface GroupRowsByTicketResult<TRow> {
  workOrders: GroupedWorkOrder<TRow>[];
  /** Count of true-duplicate part lines collapsed (same composite part key). */
  duplicatePartLineCount: number;
}

/** `Good Part Installed Status` value that marks a spare as physically received. */
export const RECEIVED_INSTALLED_STATUS = "RCV_SPARE";
/** `Good Part Installed Status` value that marks a spare as ordered, in transit. */
export const IN_TRANSIT_INSTALLED_STATUS = "YTR_INTRANSIT";

interface RankedRow<TRow> {
  firstSeenIndex: number;
  nonNullFieldCount: number;
  normalizedTicketKey: string;
  row: TRow;
  timestampMs: number | null;
}

function resolveTicketId(row: TicketDedupeRow): unknown {
  return (
    row.ticketId ??
    row.ticket_id ??
    row.normalizedTicketId ??
    row.normalized_ticket_id ??
    null
  );
}

function normalizeTicketKey(value: unknown): string {
  const normalized = normalizeTicketId(value);

  if (/^\d+$/.test(normalized)) {
    return normalized.replace(/^0+(?=\d)/, "");
  }

  const woNumericMatch = /^WO0*(\d+)$/.exec(normalized);
  if (woNumericMatch?.[1]) {
    return woNumericMatch[1].replace(/^0+(?=\d)/, "");
  }

  return normalized;
}

export function getNormalizedTicketKey(value: unknown): string {
  return normalizeTicketKey(value);
}

function isMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return cleanString(value) !== null;
  }

  if (value instanceof Date) {
    return !Number.isNaN(value.getTime());
  }

  return true;
}

function countNonNullFields<TRow extends TicketDedupeRow>(row: TRow): number {
  let count = 0;

  for (const [key, value] of Object.entries(row)) {
    if (COMPLETENESS_METADATA_FIELDS.has(key)) {
      continue;
    }

    if (isMeaningfulValue(value)) {
      count += 1;
    }
  }

  return count;
}

function toTimestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }

  const cleaned = cleanString(value);
  if (!cleaned) {
    return null;
  }

  const parsed = new Date(cleaned);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function extractLatestTimestampMs<TRow extends TicketDedupeRow>(row: TRow): number | null {
  let latestTimestampMs: number | null = null;
  const candidateFields = row as Record<string, unknown>;

  for (const fieldName of TIMESTAMP_FIELD_CANDIDATES) {
    const timestampMs = toTimestampMs(candidateFields[fieldName]);

    if (timestampMs === null) {
      continue;
    }

    if (latestTimestampMs === null || timestampMs > latestTimestampMs) {
      latestTimestampMs = timestampMs;
    }
  }

  return latestTimestampMs;
}

function shouldReplaceSelectedRow<TRow extends TicketDedupeRow>(
  current: RankedRow<TRow>,
  candidate: RankedRow<TRow>,
): boolean {
  if (candidate.nonNullFieldCount !== current.nonNullFieldCount) {
    return candidate.nonNullFieldCount > current.nonNullFieldCount;
  }

  if (candidate.timestampMs !== current.timestampMs) {
    if (candidate.timestampMs === null) {
      return false;
    }

    if (current.timestampMs === null) {
      return true;
    }

    return candidate.timestampMs > current.timestampMs;
  }

  if (candidate.row.rowNumber !== current.row.rowNumber) {
    return candidate.row.rowNumber < current.row.rowNumber;
  }

  return candidate.firstSeenIndex < current.firstSeenIndex;
}

export function dedupeRowsByTicket<TRow extends TicketDedupeRow>(
  rows: readonly TRow[],
): DedupeRowsByTicketResult<TRow> {
  const selectedRows = new Map<string, RankedRow<TRow>>();
  let duplicateCount = 0;

  rows.forEach((row, index) => {
    const normalizedTicketKey = normalizeTicketKey(resolveTicketId(row));

    if (!normalizedTicketKey) {
      return;
    }

    const candidate: RankedRow<TRow> = {
      firstSeenIndex: index,
      nonNullFieldCount: countNonNullFields(row),
      normalizedTicketKey,
      row,
      timestampMs: extractLatestTimestampMs(row),
    };
    const current = selectedRows.get(normalizedTicketKey);

    if (!current) {
      selectedRows.set(normalizedTicketKey, candidate);
      return;
    }

    duplicateCount += 1;

    if (shouldReplaceSelectedRow(current, candidate)) {
      selectedRows.set(normalizedTicketKey, candidate);
    }
  });

  return {
    dedupedRows: [...selectedRows.values()].map((entry) => entry.row),
    duplicateCount,
  };
}

/**
 * How to locate each {@link PartLine} field on an arbitrary source row. Reads a
 * camelCase prop first (parsed records), then a snake_case prop (DB rows), then
 * falls back to the raw Excel header names carried in `rawRow`/`raw_row`. This
 * keeps grouping working across the parsed-record, persisted-row, and raw shapes
 * the same data flows through.
 */
const PART_FIELD_SPECS: ReadonlyArray<{
  prop: keyof PartLine;
  camel: string;
  snake: string;
  raw: readonly string[];
}> = [
  {
    prop: "goodPartNo",
    camel: "goodPartNo",
    snake: "good_part_no",
    raw: ["Good Part No", "Good Part Number"],
  },
  {
    prop: "partDescription",
    camel: "partDescription",
    snake: "part_description",
    raw: ["Part Description", "Part"],
  },
  {
    prop: "partOrderNo",
    camel: "partOrderNo",
    snake: "part_order_no",
    raw: ["Part Order No", "Part Order Number"],
  },
  {
    prop: "soNumber",
    camel: "soNumber",
    snake: "so_number",
    raw: ["SO Number", "So Number"],
  },
  {
    prop: "goodPartInstalledStatus",
    camel: "goodPartInstalledStatus",
    snake: "good_part_installed_status",
    raw: ["Good Part Installed Status"],
  },
  {
    prop: "partShipmentStatus",
    camel: "partShipmentStatus",
    snake: "part_shipment_status",
    raw: ["Part Shipment Status(EEG)", "Part Shipment Status"],
  },
  {
    prop: "goodPartAwb",
    camel: "goodPartAwb",
    snake: "good_part_awb",
    raw: ["Good Part AWB", "Good Part Awb"],
  },
  {
    prop: "goodPartExpectedDeliveryDate",
    camel: "goodPartExpectedDeliveryDate",
    snake: "good_part_expected_delivery_date",
    raw: ["Good Part Expected Delivery Date"],
  },
  {
    prop: "goodPartSerialNumber",
    camel: "goodPartSerialNumber",
    snake: "good_part_serial_number",
    raw: ["Good Part Serial Number", "Good Part Serial No"],
  },
];

function readRawRow(row: unknown): Record<string, unknown> | null {
  if (!row || typeof row !== "object") {
    return null;
  }

  const candidate = row as { rawRow?: unknown; raw_row?: unknown };
  const raw = candidate.rawRow ?? candidate.raw_row;

  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

function readPartField(
  row: Record<string, unknown>,
  rawRow: Record<string, unknown> | null,
  spec: (typeof PART_FIELD_SPECS)[number],
): string | null {
  const direct = cleanString(row[spec.camel] ?? row[spec.snake]);
  if (direct !== null) {
    return direct;
  }

  if (rawRow) {
    for (const rawKey of spec.raw) {
      const value = cleanString(rawRow[rawKey]);
      if (value !== null) {
        return value;
      }
    }
  }

  return null;
}

/** Reads the part-level fields off any source row into a {@link PartLine}. */
export function extractPartLine<TRow>(row: TRow): PartLine {
  const record = (row ?? {}) as Record<string, unknown>;
  const rawRow = readRawRow(row);
  const partLine = {} as PartLine;

  for (const spec of PART_FIELD_SPECS) {
    partLine[spec.prop] = readPartField(record, rawRow, spec);
  }

  return partLine;
}

/**
 * True when the row carries any part identity at all. A row with no good-part
 * number, no part order number and no description is a service call with no
 * spare — it must not contribute a phantom (all-null) part line.
 */
function hasPartIdentity(part: PartLine): boolean {
  return (
    part.goodPartNo !== null ||
    part.partOrderNo !== null ||
    part.partDescription !== null
  );
}

/** Composite part-line identity within a work order: ticket + good part + part order. */
function partLineKey(ticketKey: string, part: PartLine): string {
  const goodPartNo = (part.goodPartNo ?? "").toUpperCase();
  const partOrderNo = (part.partOrderNo ?? "").toUpperCase();
  return `${ticketKey} ${goodPartNo} ${partOrderNo}`;
}

interface GroupAccumulator<TRow> {
  ticketKey: string;
  header: RankedRow<TRow>;
  partOrder: string[];
  partByKey: Map<string, PartLine>;
}

/**
 * Groups flat one-row-per-part rows into header/detail work orders.
 *
 * - Work-order identity uses {@link normalizeTicketKey} (unchanged).
 * - The single header is chosen with the EXISTING dedupe ranking
 *   (`shouldReplaceSelectedRow`: most non-null fields → latest timestamp →
 *   lowest rowNumber → first-seen).
 * - `parts[]` is deduped on the composite key (ticketKey + goodPartNo +
 *   partOrderNo): true duplicate lines collapse, genuinely different parts and
 *   re-orders under a new Part Order No are kept as distinct lines.
 *
 * No parts are lost: distinct part lines out == distinct part lines in.
 */
export function groupRowsByTicket<TRow extends TicketDedupeRow>(
  rows: readonly TRow[],
): GroupRowsByTicketResult<TRow> {
  const groups = new Map<string, GroupAccumulator<TRow>>();
  const order: string[] = [];
  let duplicatePartLineCount = 0;

  rows.forEach((row, index) => {
    const ticketKey = normalizeTicketKey(resolveTicketId(row));

    if (!ticketKey) {
      return;
    }

    const candidate: RankedRow<TRow> = {
      firstSeenIndex: index,
      nonNullFieldCount: countNonNullFields(row),
      normalizedTicketKey: ticketKey,
      row,
      timestampMs: extractLatestTimestampMs(row),
    };

    let group = groups.get(ticketKey);
    if (!group) {
      group = {
        ticketKey,
        header: candidate,
        partOrder: [],
        partByKey: new Map<string, PartLine>(),
      };
      groups.set(ticketKey, group);
      order.push(ticketKey);
    } else if (shouldReplaceSelectedRow(group.header, candidate)) {
      group.header = candidate;
    }

    const partLine = extractPartLine(row);
    if (!hasPartIdentity(partLine)) {
      return;
    }

    const key = partLineKey(ticketKey, partLine);
    const existing = group.partByKey.get(key);
    if (!existing) {
      group.partByKey.set(key, partLine);
      group.partOrder.push(key);
      return;
    }

    // A true duplicate part line: same ticket + good part + part order. Keep the
    // most complete copy so no populated field is lost to the dedupe.
    duplicatePartLineCount += 1;
    group.partByKey.set(key, mergePartLines(existing, partLine));
  });

  const workOrders = order.map<GroupedWorkOrder<TRow>>((ticketKey) => {
    const group = groups.get(ticketKey)!;
    return {
      ticketKey,
      header: group.header.row,
      parts: group.partOrder.map((key) => group.partByKey.get(key)!),
    };
  });

  return { workOrders, duplicatePartLineCount };
}

/** Fills blanks in `current` from `candidate` without overwriting populated fields. */
function mergePartLines(current: PartLine, candidate: PartLine): PartLine {
  const merged = { ...current };

  for (const spec of PART_FIELD_SPECS) {
    if (merged[spec.prop] === null && candidate[spec.prop] !== null) {
      merged[spec.prop] = candidate[spec.prop];
    }
  }

  return merged;
}

/** Only the parts physically received (`Good Part Installed Status === RCV_SPARE`). */
export function filterReceivedParts(
  parts: readonly PartLine[],
): PartLine[] {
  return parts.filter(
    (part) => part.goodPartInstalledStatus === RECEIVED_INSTALLED_STATUS,
  );
}

/** Parts ordered but not yet received (`Good Part Installed Status === YTR_INTRANSIT`). */
export function filterInTransitParts(
  parts: readonly PartLine[],
): PartLine[] {
  return parts.filter(
    (part) => part.goodPartInstalledStatus === IN_TRANSIT_INSTALLED_STATUS,
  );
}

export interface OpenCallPartDisplay {
  /**
   * `" / "`-joined descriptions of EVERY part on the work order — all installed
   * statuses (RCV_SPARE and YTR_INTRANSIT alike), in source/row order. Empty
   * when the work order carries no part descriptions.
   */
  text: string;
  /** True when the work order has no part lines at all (`parts.length === 0`). */
  awaitingParts: boolean;
}

/**
 * OpenCall "Part" column model for a work order. Unlike the Inventory view (which
 * is received-only via {@link filterReceivedParts}), the OpenCall cell lists
 * EVERY part on the work order regardless of `Good Part Installed Status`, joined
 * with `" / "` in source order. Part lines are already de-duplicated upstream on
 * the composite key `(ticket + goodPartNo + partOrderNo)` by
 * {@link groupRowsByTicket}, so any two identical descriptions here are genuinely
 * distinct part lines (e.g. the same good part re-ordered under a new Part Order
 * No) and are both kept. `awaitingParts` means the work order has no parts at all.
 *
 * This is intentionally independent of the received filter so the display can
 * never leak into what Inventory stocks — the sync path stays received-only.
 */
export function buildOpenCallPartDisplay(
  parts: readonly PartLine[],
): OpenCallPartDisplay {
  const text = parts
    .map((part) => part.partDescription)
    .filter((description): description is string => Boolean(description))
    .join(" / ");

  return {
    text,
    awaitingParts: parts.length === 0,
  };
}

/** Formats {@link buildOpenCallPartDisplay} into a single "Part" cell string. */
export function formatOpenCallPartCell(parts: readonly PartLine[]): string {
  const display = buildOpenCallPartDisplay(parts);

  if (display.text) {
    return display.text;
  }

  return display.awaitingParts ? "Awaiting parts" : "";
}

/**
 * Sums a numeric value over the received parts (price / in-stock value). An
 * in-transit part is not a cost in hand, so it is excluded.
 */
export function sumReceivedPartValues(
  parts: readonly PartLine[],
  getValue: (part: PartLine) => number | null | undefined,
): number {
  return filterReceivedParts(parts).reduce((total, part) => {
    const value = getValue(part);
    return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
}

/** Key a row occupies in the part-line space: composite part key, or ticket key for a no-part service line. */
function partLineRowKey<TRow extends TicketDedupeRow>(row: TRow): string | null {
  const ticketKey = normalizeTicketKey(resolveTicketId(row));

  if (!ticketKey) {
    return null;
  }

  const partLine = extractPartLine(row);
  return hasPartIdentity(partLine) ? partLineKey(ticketKey, partLine) : ticketKey;
}

export interface DedupePartLineRowsResult<TRow> {
  rows: TRow[];
  duplicatePartLineCount: number;
}

/**
 * Flat-row dedup on the composite PART key (ticketKey + goodPartNo +
 * partOrderNo) instead of the ticket key. Unlike {@link dedupeRowsByTicket}
 * this KEEPS multiple rows per work order — one per distinct part line — so no
 * spare part is lost at parse/persist time. It only collapses true duplicate
 * part lines (same composite key), keeping the most complete row via the
 * existing ranking. Rows with no part identity fall back to the ticket key, so
 * for part-less reports (Renderways / Call Plan) this behaves exactly like
 * {@link dedupeRowsByTicket}.
 */
export function dedupePartLineRows<TRow extends TicketDedupeRow>(
  rows: readonly TRow[],
): DedupePartLineRowsResult<TRow> {
  const selected = new Map<string, RankedRow<TRow>>();
  const order: string[] = [];
  let duplicatePartLineCount = 0;

  rows.forEach((row, index) => {
    const key = partLineRowKey(row);

    if (!key) {
      return;
    }

    const candidate: RankedRow<TRow> = {
      firstSeenIndex: index,
      nonNullFieldCount: countNonNullFields(row),
      normalizedTicketKey: normalizeTicketKey(resolveTicketId(row)),
      row,
      timestampMs: extractLatestTimestampMs(row),
    };

    const current = selected.get(key);
    if (!current) {
      selected.set(key, candidate);
      order.push(key);
      return;
    }

    duplicatePartLineCount += 1;
    if (shouldReplaceSelectedRow(current, candidate)) {
      selected.set(key, candidate);
    }
  });

  return {
    rows: order.map((key) => selected.get(key)!.row),
    duplicatePartLineCount,
  };
}

export function findDuplicateTicketKeys<TRow extends TicketDedupeRow>(
  rows: readonly TRow[],
): string[] {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const normalizedTicketKey = normalizeTicketKey(resolveTicketId(row));

    if (!normalizedTicketKey) {
      continue;
    }

    counts.set(normalizedTicketKey, (counts.get(normalizedTicketKey) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort();
}

/**
 * Part-line analogue of {@link findDuplicateTicketKeys}: returns composite part
 * keys that survive more than once. A repeated *ticket* is legal now (multi-part
 * work orders), so the residual-duplicate guard must use this, not the ticket.
 */
export function findDuplicatePartLineKeys<TRow extends TicketDedupeRow>(
  rows: readonly TRow[],
): string[] {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const key = partLineRowKey(row);

    if (!key) {
      continue;
    }

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort();
}
