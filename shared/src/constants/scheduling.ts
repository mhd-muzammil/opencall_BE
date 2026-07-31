// Scheduling + part-shipment constants shared by backend generation, backend
// edit, and the frontend guard so they can never disagree.

/**
 * The status value that triggers the scheduling rules (engineer required +
 * auto "Scheduled on" remark). Configurable in one place — the team's
 * admin-managed RTPL statuses define the literal string; today that is
 * "Scheduled". Matching is case-insensitive/trimmed via `isScheduledStatus`.
 */
export const SCHEDULED_STATUS = "Scheduled";

export function isScheduledStatus(value: string | null | undefined): boolean {
  return (
    (value ?? "").trim().toLowerCase() === SCHEDULED_STATUS.toLowerCase()
  );
}

/**
 * The status that triggers the KCI (Keep Customer Informed) RCA rule: moving a
 * status column to Customer Pending appends the current remarks + "KCI Done"
 * to the RCA. Matching is case-insensitive/trimmed.
 */
export const CUSTOMER_PENDING_STATUS = "Customer Pending";

export function isCustomerPendingStatus(
  value: string | null | undefined,
): boolean {
  return (
    (value ?? "").trim().toLowerCase() === CUSTOMER_PENDING_STATUS.toLowerCase()
  );
}

/**
 * The status that triggers the part-ETA remark: moving a status column to
 * SSC Pending writes "ETA <case created + SSC_PENDING_ETA_OFFSET_DAYS>" into
 * Current Remarks, so the team sees when the part is due without opening the
 * RCA. Matches "SSC Pending" and its longer spelling ("SSC Pending → Part
 * Pending"), case-insensitive and punctuation-insensitive.
 */
export const SSC_PENDING_STATUS = "SSC Pending";

/**
 * Calendar days after Case Created Time that an SSC-pending part is due.
 * Deliberately the same offset PART_SHIPMENT_ETA gives an "Ordered" part, so
 * the Current Remarks line and the RCA's ETA can never disagree.
 */
export const SSC_PENDING_ETA_OFFSET_DAYS = 2;

export function isSscPendingStatus(value: string | null | undefined): boolean {
  const normalized = (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return normalized === "ssc" || normalized.startsWith("ssc pending");
}

/**
 * WO-level part-shipment status precedence, most-blocking first. A work order
 * can carry many part lines each with its own status; `pickWorkOrderShipmentStatus`
 * collapses them to the single most-blocking one for the RCA line.
 */
export const PART_SHIPMENT_STATUS_PRECEDENCE = [
  "Backordered",
  "Recommended",
  "Ordered",
  "Locked",
  "Shipped",
  "POD",
  "Closed",
] as const;

/**
 * The single source of truth mapping a part-shipment status to its RCA ETA.
 * `label` = a literal ETA string; `offsetDays` = an ETA date derived purely
 * from case_created_time (Ordered = +2 calendar days, Shipped/Locked = +1,
 * POD = same day). An unknown status is echoed verbatim (handled in
 * `resolveShipmentEta`).
 */
export type ShipmentEtaRule =
  | { readonly kind: "label"; readonly label: string }
  | { readonly kind: "offsetDays"; readonly offsetDays: number };

export const PART_SHIPMENT_ETA: Readonly<Record<string, ShipmentEtaRule>> = {
  recommended: { kind: "label", label: "Part Recommended" },
  backordered: { kind: "label", label: "Backordered" },
  ordered: { kind: "offsetDays", offsetDays: 2 },
  shipped: { kind: "offsetDays", offsetDays: 1 },
  locked: { kind: "offsetDays", offsetDays: 1 },
  pod: { kind: "offsetDays", offsetDays: 0 },
  closed: { kind: "label", label: "Closed" },
};
