// Auto-RCA and auto-remark text builders — the single source of truth for the
// exact strings written into the "RCA" and "Current Remarks" columns. Backend
// generation and the backend edit service both call these, so the text can
// never drift between paths. Templates are byte-exact (see rcaText.test.ts).

import {
  PART_SHIPMENT_ETA,
  PART_SHIPMENT_STATUS_PRECEDENCE,
} from "../constants/scheduling.js";
import { addCalendarDays, formatOrdinalDate } from "./dates.js";

/** A part line as far as RCA cares: just its shipment status. */
export interface ShipmentPart {
  partShipmentStatus?: string | null;
}

function isMeaningful(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  return v.length > 0 && v.toLowerCase() !== "manual entry required";
}

/**
 * Collapse a WO's part lines to one shipment status by precedence
 * (most-blocking first). Known statuses rank per PART_SHIPMENT_STATUS_PRECEDENCE;
 * an unrecognised-but-present status ranks last (least blocking) so it only
 * wins when nothing known is present. Returns null when no part carries a
 * status. The returned string keeps the part's original casing.
 */
export function pickWorkOrderShipmentStatus(
  parts: readonly ShipmentPart[] | null | undefined,
): string | null {
  if (!parts || parts.length === 0) return null;

  const rank = (status: string): number => {
    const idx = PART_SHIPMENT_STATUS_PRECEDENCE.findIndex(
      (s) => s.toLowerCase() === status.trim().toLowerCase(),
    );
    return idx === -1 ? PART_SHIPMENT_STATUS_PRECEDENCE.length : idx;
  };

  let best: string | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const part of parts) {
    const status = (part.partShipmentStatus ?? "").trim();
    if (!status) continue;
    const r = rank(status);
    if (r < bestRank) {
      bestRank = r;
      best = status;
    }
  }
  return best;
}

/**
 * The ETA label for a part-shipment status, derived purely from
 * case_created_time (NOT from any delivery-date field):
 *   Recommended -> "Part Recommended", Backordered -> "Backordered",
 *   Ordered -> created + 2 days (ordinal), Shipped/Locked -> created + 1 day,
 *   POD -> created (same day), Closed -> "Closed",
 *   any other status -> that status verbatim.
 * Case-insensitive/trimmed.
 */
export function resolveShipmentEta(
  status: string | null | undefined,
  caseCreatedTime: string | null | undefined,
): string {
  const normalized = (status ?? "").trim().toLowerCase();
  const rule = PART_SHIPMENT_ETA[normalized];
  if (!rule) {
    return (status ?? "").trim();
  }
  if (rule.kind === "label") {
    return rule.label;
  }
  const target =
    rule.offsetDays === 0
      ? caseCreatedTime ?? ""
      : addCalendarDays(caseCreatedTime, rule.offsetDays);
  return formatOrdinalDate(target);
}

export interface AutoRcaInput {
  caseCreatedTime: string | null | undefined;
  /** WO has ≥1 real part line (part cell non-empty and not "Awaiting parts"). */
  isPartCase: boolean;
  /** The Part cell text exactly as displayed (formatOpenCallPartCell). */
  partText: string | null | undefined;
  /** WO-level shipment status (pickWorkOrderShipmentStatus). */
  partShipmentStatus: string | null | undefined;
  /** Assigned engineer (drives the active-case "engineer scheduled" suffix). */
  engineer: string | null | undefined;
  /** Today as "YYYY-MM-DD" (istTodayIso). */
  todayIso: string;
}

/**
 * Build the auto-RCA line. Byte-exact templates:
 *   active:            Case Received on {RCVD} - active case
 *   active + engineer: Case Received on {RCVD} - active case - engineer scheduled {SCHED}
 *   part case:         Case Received on {RCVD} - with part - ({PARTS}) ETA: {eta}
 */
export function buildAutoRca(input: AutoRcaInput): string {
  const received = formatOrdinalDate(input.caseCreatedTime);
  const rcvd = received || "Unknown Date";

  if (input.isPartCase) {
    const parts = (input.partText ?? "").trim();
    const eta = resolveShipmentEta(input.partShipmentStatus, input.caseCreatedTime);
    return `Case Received on ${rcvd} - with part - (${parts}) ETA: ${eta}`;
  }

  let line = `Case Received on ${rcvd} - active case`;
  if (isMeaningful(input.engineer)) {
    line += ` - engineer scheduled ${formatOrdinalDate(input.todayIso)}`;
  }
  return line;
}

/** "Scheduled on {today}" e.g. "Scheduled on 20th July". */
export function buildScheduledRemark(todayIso: string): string {
  return `Scheduled on ${formatOrdinalDate(todayIso)}`;
}

/**
 * "Part case" test on the displayed Part cell: a non-empty cell that isn't the
 * "Awaiting parts" placeholder (with or without an in-transit marker).
 */
export function isPartCaseText(partText: string | null | undefined): boolean {
  const main = (partText ?? "").split("  ⏳ ")[0]?.trim() ?? "";
  return main.length > 0 && main !== "Awaiting parts";
}
