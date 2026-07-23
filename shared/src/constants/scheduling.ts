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
