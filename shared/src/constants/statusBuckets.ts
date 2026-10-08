// Which BOD/EOD row an RTPL status counts under.
//
// The admin picks the row for every status on the RTPL Statuses page; the
// choice is stored in rtpl_statuses.bod_eod_bucket. Every surface that groups
// calls by status reads that stored choice through this module: the BOD/EOD
// table (web, mobile, Excel export), the Overview tiles and Engineer
// Productivity, live and in the backend Final-EOD freeze.
//
// Before this, each surface guessed the row from words in the status name, with
// its own keyword list. A new status whose name contained none of the words
// landed in no row (and in productivity, silently counted as Attended), and a
// rename could quietly move a status into a different row.
//
// Status text that is NOT in the admin list — a deleted status still sitting in
// old report rows, or free text from before the list existed — has no stored
// row, and keeps the old keyword behaviour (`LEGACY_BOD_EOD_ROW_KEYWORDS`).
//
// Two copies of shared/ exist (frontend and backend repos); they must stay
// identical.

export const STATUS_BUCKETS = [
  "SCHEDULED",
  "TO_BE_SCHEDULE",
  "ONSITE",
  "CX_RESCHEDULE",
  "ENGINEER_DELAY",
  "SSC_PENDING",
  "ELEVATE_TECH",
  "UNDER_OBSERVATION",
  "TO_BE_YANK",
  "ADD_PART_ORDERED",
  "TO_BE_CANCEL",
  "CLOSED",
  "OTHER",
] as const;

export type StatusBucket = (typeof STATUS_BUCKETS)[number];

/** The BOD/EOD row each bucket counts under, as the table labels it. */
export const STATUS_BUCKET_LABELS: Readonly<Record<StatusBucket, string>> = {
  SCHEDULED: "Planned (Scheduled / Engineer assigned)",
  TO_BE_SCHEDULE: "To be Schedule",
  ONSITE: "Engg Onsite",
  CX_RESCHEDULE: "Customer Pending (Cx Reschedule)",
  ENGINEER_DELAY: "Engineer Delay",
  SSC_PENDING: "SSC Pending",
  ELEVATE_TECH: "Elevate / Tech",
  UNDER_OBSERVATION: "Under Observation",
  TO_BE_YANK: "To be Yank",
  ADD_PART_ORDERED: "Add Part Ordered",
  TO_BE_CANCEL: "To be Cancel",
  CLOSED: "Closed Calls",
  OTHER: "Other (no BOD/EOD row)",
};

export function isStatusBucket(value: unknown): value is StatusBucket {
  return (
    typeof value === "string" &&
    (STATUS_BUCKETS as readonly string[]).includes(value)
  );
}

/**
 * Engineer Productivity follows the same choice, so the BOD/EOD table and the
 * productivity columns can never disagree about a status. Only the outcome
 * buckets productivity has columns for are named; everything else is attended
 * work with no column of its own.
 */
export const PRODUCTIVITY_BUCKET_FOR_STATUS_BUCKET = {
  SCHEDULED: "SCHEDULED",
  TO_BE_SCHEDULE: "SCHEDULED",
  ONSITE: "ATTENDED_OTHER",
  CX_RESCHEDULE: "CX_RESCHEDULE",
  ENGINEER_DELAY: "ENGINEER_DELAY",
  SSC_PENDING: "PART_ORDER",
  ELEVATE_TECH: "UNDER_OBSERVATION",
  UNDER_OBSERVATION: "UNDER_OBSERVATION",
  TO_BE_YANK: "ATTENDED_OTHER",
  ADD_PART_ORDERED: "PART_ORDER",
  TO_BE_CANCEL: "ATTENDED_OTHER",
  CLOSED: "CLOSED",
  OTHER: "ATTENDED_OTHER",
} as const satisfies Record<StatusBucket, string>;

// ---------------------------------------------------------------------------
// Custom rows: BOD/EOD rows a Super Admin adds on the RTPL Statuses page, for a
// status that fits none of the built-in rows. A status points at one by its
// key ("C_" + hex), stored in the same rtpl_statuses.bod_eod_bucket column.
// ---------------------------------------------------------------------------

/**
 * How a custom row's calls count in Engineer Productivity, which has fixed
 * columns. CLOSED is deliberately not offered: a completed close is decided by
 * Flex closure reconciliation, not by a row an admin names.
 */
export const CUSTOM_ROW_PRODUCTIVITY_CHOICES = [
  { value: "ATTENDED_OTHER", label: "Attended" },
  { value: "PART_ORDER", label: "Attended: Part ordered" },
  { value: "UNDER_OBSERVATION", label: "Attended: Under Observation / Elevation" },
  { value: "CX_RESCHEDULE", label: "Not attended: Customer Pending" },
  { value: "ENGINEER_DELAY", label: "Not attended: Engineer Delay" },
  { value: "SCHEDULED", label: "Not attended: still to be scheduled" },
] as const;

export type CustomRowProductivity =
  (typeof CUSTOM_ROW_PRODUCTIVITY_CHOICES)[number]["value"];

export function isCustomRowProductivity(value: unknown): value is CustomRowProductivity {
  return CUSTOM_ROW_PRODUCTIVITY_CHOICES.some((c) => c.value === value);
}

/** The built-in rows a custom row can be placed after (everything but Other). */
export const CUSTOM_ROW_ANCHORS: readonly StatusBucket[] = STATUS_BUCKETS.filter(
  (bucket) => bucket !== "OTHER",
);

export interface CustomBodEodRow {
  key: string;
  label: string;
  productivityBucket: CustomRowProductivity;
  /** The built-in row this one is shown directly after. */
  afterRow: StatusBucket;
  sortOrder: number;
  /** A hidden row is left out of the tables and the row picker. */
  isActive: boolean;
}

const CUSTOM_ROW_KEY = /^C_[a-z0-9]{6,24}$/;

export function isCustomRowKey(value: unknown): value is string {
  return typeof value === "string" && CUSTOM_ROW_KEY.test(value);
}

/** A built-in bucket or a custom row's key: what a status can point at. */
export function isBodEodRowKey(value: unknown): value is string {
  return isStatusBucket(value) || isCustomRowKey(value);
}

// ---------------------------------------------------------------------------
// The stored mapping, loaded from the admin list.
//
// Module state rather than a parameter: the classifier is called from dozens of
// places on both sides, and threading a map through each would mean one missed
// call site counts differently from the rest. The frontend loads it with the
// status dropdown; the backend loads it before computing productivity.
// ---------------------------------------------------------------------------

let bucketByStatus = new Map<string, string>();
let customRows: CustomBodEodRow[] = [];
let mappingVersion = 0;
const listeners = new Set<() => void>();

function statusKey(status: unknown): string {
  return String(status ?? "").trim().toLowerCase();
}

function notify(): void {
  mappingVersion += 1;
  for (const listener of listeners) listener();
}

export interface StatusBucketEntry {
  name: string;
  bucket?: string | null;
}

/**
 * Replace the stored mapping. Entries without a valid row are skipped (an
 * older API that does not send one yet), so those statuses keep the keyword
 * fallback rather than counting nowhere.
 */
export function setStatusBucketMap(entries: readonly StatusBucketEntry[]): void {
  const next = new Map<string, string>();
  for (const entry of entries) {
    const key = statusKey(entry.name);
    if (key && isBodEodRowKey(entry.bucket) && !next.has(key)) {
      next.set(key, entry.bucket);
    }
  }

  const unchanged =
    next.size === bucketByStatus.size &&
    [...next].every(([key, bucket]) => bucketByStatus.get(key) === bucket);
  if (unchanged) return;

  bucketByStatus = next;
  notify();
}

/** Replace the custom rows (hidden ones included). */
export function setCustomBodEodRows(rows: readonly CustomBodEodRow[]): void {
  const next = rows
    .filter((row) => isCustomRowKey(row.key))
    .map((row) => ({ ...row }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
  if (JSON.stringify(next) === JSON.stringify(customRows)) return;
  customRows = next;
  notify();
}

/** Custom rows in display order; hidden rows only when asked for. */
export function getCustomBodEodRows(
  options: { includeHidden?: boolean } = {},
): readonly CustomBodEodRow[] {
  return options.includeHidden ? customRows : customRows.filter((row) => row.isActive);
}

/** The admin-chosen row for this status, or undefined when it has none. */
export function getMappedStatusBucket(status: unknown): string | undefined {
  return bucketByStatus.get(statusKey(status));
}

/** The label of a built-in or custom row, for display. */
export function bodEodRowLabel(key: string | null | undefined): string {
  if (isStatusBucket(key)) return STATUS_BUCKET_LABELS[key];
  const custom = customRows.find((row) => row.key === key);
  if (custom) return custom.label;
  return key ? "Unknown row" : "Not set";
}

/**
 * The Engineer Productivity bucket for a row. A status pointing at a custom row
 * that no longer exists counts as attended work, like any unnamed status.
 */
export function productivityBucketForRow(
  key: string,
): (typeof PRODUCTIVITY_BUCKET_FOR_STATUS_BUCKET)[StatusBucket] | CustomRowProductivity {
  if (isStatusBucket(key)) return PRODUCTIVITY_BUCKET_FOR_STATUS_BUCKET[key];
  return customRows.find((row) => row.key === key)?.productivityBucket ?? "ATTENDED_OTHER";
}

/**
 * Lay a table out with the visible custom rows slotted in: each one directly
 * after the built-in row it was placed after. A custom row whose anchor this
 * table does not show goes at the end, so it is never silently dropped.
 */
export function withCustomBodEodRows<T>(
  builtins: readonly T[],
  anchorOf: (item: T) => StatusBucket | undefined,
  makeCustom: (row: CustomBodEodRow) => T,
): T[] {
  const visible = getCustomBodEodRows();
  if (visible.length === 0) return [...builtins];

  const placed = new Set<string>();
  const out: T[] = [];
  for (const item of builtins) {
    out.push(item);
    const anchor = anchorOf(item);
    if (!anchor) continue;
    for (const row of visible) {
      if (row.afterRow === anchor && !placed.has(row.key)) {
        out.push(makeCustom(row));
        placed.add(row.key);
      }
    }
  }
  for (const row of visible) {
    if (!placed.has(row.key)) out.push(makeCustom(row));
  }
  return out;
}

/** Bumps whenever the mapping or the custom rows change: for memo dependencies. */
export function getStatusBucketVersion(): number {
  return mappingVersion;
}

export function subscribeStatusBuckets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// The keyword fallback, for status text with no stored bucket. These are the
// lists the BOD/EOD table used before the mapping existed, unchanged — a row
// could match more than one list, and unmapped text still can.
// ---------------------------------------------------------------------------

type KeywordRule = { keywords: readonly string[]; excludes?: readonly string[] };

export const LEGACY_BOD_EOD_ROW_KEYWORDS: Readonly<
  Partial<Record<StatusBucket, KeywordRule>>
> = {
  TO_BE_SCHEDULE: { keywords: ["to be scheduled", "assignment pending", "non avl", "missed to schedule"] },
  CX_RESCHEDULE: { keywords: ["cx pending", "reschedule", "cx", "cust delay", "customer delay", "customer pending"] },
  ENGINEER_DELAY: { keywords: ["engineer delay", "eng delay"] },
  SSC_PENDING: { keywords: ["ssc pending", "ssc"] },
  ELEVATE_TECH: { keywords: ["elevation hp pending", "elevation part pending", "elevation - hp pending", "elevation - partner pending", "elevate"] },
  UNDER_OBSERVATION: { keywords: ["crt pending", "ct validation pending", "observation", "under observation", "crt"] },
  TO_BE_YANK: { keywords: ["need to yank", "yank"] },
  ADD_PART_ORDERED: { keywords: ["additional part", "part order pending", "parts hold", "part need to order"] },
  TO_BE_CANCEL: { keywords: ["need to cancel", "need to cancel mail", "request to cancel"] },
};

function normalizeLoose(status: unknown): string {
  return String(status ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isBlankStatus(status: unknown): boolean {
  const s = statusKey(status);
  return !s || s === "manual entry required";
}

/** The pre-mapping exact/keyword tests for the rows that never used lists. */
function legacyInRow(status: unknown, bucket: StatusBucket): boolean {
  const loose = normalizeLoose(status);
  switch (bucket) {
    case "SCHEDULED":
      return (
        loose === "scheduled" ||
        loose === "engg assigned" ||
        loose === "eng assigned" ||
        loose === "engineer assigned"
      );
    case "ONSITE":
      return loose.includes("onsite");
    case "CLOSED":
      return loose.includes("case close") || loose.includes("wo close");
    case "OTHER":
      return false;
    default: {
      const rule = LEGACY_BOD_EOD_ROW_KEYWORDS[bucket];
      if (!rule) return false;
      const s = statusKey(status);
      return (
        rule.keywords.some((kw) => s.includes(kw)) &&
        !(rule.excludes ?? []).some((ex) => s.includes(ex))
      );
    }
  }
}

/**
 * Does this status count under this BOD/EOD row? The stored choice decides when
 * there is one (a status counts under exactly one row); otherwise the old
 * keyword test does.
 */
export function statusInBodEodRow(status: unknown, bucket: string): boolean {
  if (isBlankStatus(status)) return false;
  const mapped = getMappedStatusBucket(status);
  if (mapped) return mapped === bucket;
  // Custom rows only ever hold statuses that were explicitly put there.
  return isStatusBucket(bucket) && legacyInRow(status, bucket);
}

/**
 * Actionable = "Scheduled" itself plus everything waiting to be scheduled.
 * Unmapped text keeps the old exact test ("Scheduled" / "To be Scheduled").
 */
export function isActionableStatus(status: unknown): boolean {
  if (isBlankStatus(status)) return false;
  const loose = normalizeLoose(status);
  if (loose === "scheduled") return true;
  const mapped = getMappedStatusBucket(status);
  if (mapped) return mapped === "TO_BE_SCHEDULE";
  return loose === "to be scheduled";
}

/**
 * The single row an existing status name belonged to under the keyword rules —
 * used once, to fill the stored bucket for statuses that predate it, and as the
 * suggested row when an admin adds a new status.
 *
 * Where the old BOD/EOD lists and the old productivity classifier disagreed,
 * this picks the row that changes the fewest numbers; the backfill script
 * prints every status and its row so prod's list can be checked.
 */
export function suggestStatusBucket(name: string): StatusBucket {
  const loose = normalizeLoose(name);
  if (!loose) return "OTHER";

  if (
    loose === "to be scheduled" ||
    loose === "engg assignment pending"
  ) {
    return "TO_BE_SCHEDULE";
  }
  if (legacyInRow(name, "SCHEDULED")) return "SCHEDULED";
  if (legacyInRow(name, "CLOSED")) return "CLOSED";
  if (legacyInRow(name, "ONSITE")) return "ONSITE";

  const order: StatusBucket[] = [
    "TO_BE_SCHEDULE",
    "CX_RESCHEDULE",
    "ENGINEER_DELAY",
    "SSC_PENDING",
    "ELEVATE_TECH",
    "UNDER_OBSERVATION",
    "TO_BE_YANK",
    "ADD_PART_ORDERED",
    "TO_BE_CANCEL",
  ];
  for (const bucket of order) {
    if (legacyInRow(name, bucket)) return bucket;
  }

  // Named by the old productivity classifier but by no BOD/EOD list.
  if (loose.startsWith("elevation") || loose === "hp pending") return "ELEVATE_TECH";
  if (loose.includes("part order")) return "ADD_PART_ORDERED";
  if (loose.includes("customer pending") || loose.includes("reshedule")) return "CX_RESCHEDULE";

  return "OTHER";
}

// ---------------------------------------------------------------------------
// Statuses other code matches by exact name. Renaming, deleting, disabling or
// re-bucketing one of these would break that code, so the admin page locks them.
// ---------------------------------------------------------------------------

/**
 * "Scheduled" is the plan gate (isScheduledStatus), "Customer Pending" triggers
 * the KCI RCA rule (isCustomerPendingStatus), and the closure statuses are what
 * closure reconciliation looks for. Each returns the bucket it is fixed to.
 */
export function lockedStatusBucket(name: string): StatusBucket | null {
  const loose = normalizeLoose(name);
  if (loose === "scheduled") return "SCHEDULED";
  if (loose === "customer pending") return "CX_RESCHEDULE";
  if (loose.includes("case close") || loose.includes("wo close")) return "CLOSED";
  return null;
}
