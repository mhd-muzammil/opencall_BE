// Engineer-productivity — the ONE implementation both the frontend live view
// and the backend Final-EOD freeze call, so live and frozen numbers can never
// diverge.
//
// Day-scoped model (per region, per working day):
//
//   Assigned = the day's PLAN: what the coordinators BOOKED to the engineer.
//              A call is in today's Assigned ONLY when its current
//              (Morning/RTPL) status is a scheduling status (Scheduled /
//              To be Scheduled / Engg Assigned) and an engineer is set —
//              scheduling a call auto-writes the "Scheduled on <date>" remark,
//              so the plan is exactly the booked set. Carried backlog in any
//              other status (SSC Pending, Customer Pending, Under
//              Observation, ...) is NOT Assigned — even when it gets a today
//              Evening entry or closes today. Work on unplanned calls never
//              inflates Assigned or the outcome columns.
//   Attended = a PLANNED call worked past the scheduling stage, from the
//              Evening (today) status ONLY (or a same-day closure) — the
//              Morning status decides plan membership, never the outcome, so a
//              stale carried "SSC Pending" can never count as
//              Part-ordered/Attended.
//            = CLOSED + PART_ORDER + UNDER_OBSERVATION + ATTENDED_OTHER.
//              CX Reschedule and Engineer Delay are Assigned but NOT Attended.
//
// Status vocabulary (tolerant matching, unchanged):
//   Scheduled / To be Scheduled / Engg Assigned -> SCHEDULED (booked only)
//   Case-Closed / WO Closed (or closed today)   -> CLOSED
//   SSC Pending / Part Order / Additional Part  -> PART_ORDER
//   Under Observation                           -> UNDER_OBSERVATION
//   CX Pending / CX Reschedule                  -> CX_RESCHEDULE
//   Engineer Delay                              -> ENGINEER_DELAY
//   any other status                            -> ATTENDED_OTHER
import { ASP_CODE_REGION_MAP } from "../constants/regions.js";

export type ProductivityBucket =
  | "SCHEDULED"
  | "CLOSED"
  | "PART_ORDER"
  | "UNDER_OBSERVATION"
  | "CX_RESCHEDULE"
  | "ENGINEER_DELAY"
  | "ATTENDED_OTHER";

/** Placeholder the report writes into not-yet-filled manual fields. */
export const PRODUCTIVITY_MANUAL_PLACEHOLDER = "Manual Entry Required";

/**
 * The minimal row shape the calculation needs. Both the backend's
 * GeneratedDailyCallPlanRow and the frontend's GeneratedReportResponse rows
 * satisfy it structurally.
 */
export interface ProductivityReportRow {
  serialNo: number;
  output: Record<string, string | number>;
  carryForward: {
    closedSyntheticRow: boolean;
    sameDayClosedRow: boolean;
  };
  comparison?: { previousFlexStatus?: string | null } | null;
}

function cleanFieldValue(value: unknown): string {
  const text = String(value ?? "").trim();
  return text === PRODUCTIVITY_MANUAL_PLACEHOLDER ? "" : text;
}

/** The Morning/current status — decides PLAN membership (is it Scheduled?). */
export function morningProductivityStatus(
  output: Record<string, string | number>,
): string {
  return cleanFieldValue(output["RTPL status"]);
}

/** The Evening (today) status — the ONLY status that decides the outcome. */
export function eveningProductivityStatus(
  output: Record<string, string | number>,
): string {
  return cleanFieldValue(output["Evening status"]);
}

/**
 * Classify a status into its productivity bucket, or null when the status is
 * blank (the row must not count at all). Matching is tolerant of the casing,
 * punctuation and spelling variants that appear in real data ("WO-closed",
 * "wo closed", "CX Reshedule", "Part Order Pending", ...), but deliberately
 * narrower than the old keyword matching: "Part Quote Shared" or
 * "Good Part Received" are attended work, not part orders, and "To be
 * Scheduled" is not a reschedule.
 */
export function classifyProductivityStatus(
  status: string,
): ProductivityBucket | null {
  const normalized = status
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  if (!normalized) {
    return null;
  }

  // The scheduling stage: the call is booked to the engineer but no work has
  // happened yet — Assigned, not Attended. Attended starts at whatever status
  // comes AFTER these. Exact matches, so "CX Reschedule" (contains "schedule")
  // can never land here.
  if (
    normalized === "scheduled" ||
    normalized === "to be scheduled" ||
    normalized === "engg assigned" ||
    normalized === "eng assigned" ||
    normalized === "engineer assigned" ||
    normalized === "engg assignment pending"
  ) {
    return "SCHEDULED";
  }

  // "Case-Closed" / "WO-closed" and manual variants. Deliberately not
  // "Closed-cancellation" / "Need to Close": a cancellation or an intent to
  // close is attended work, not a completed close.
  if (normalized.includes("case close") || normalized.includes("wo close")) {
    return "CLOSED";
  }

  // The team logs part waits as "SSC Pending" (incl. "SSC Pending → Part
  // Pending"); explicit part orders count here too.
  if (
    normalized.includes("ssc") ||
    normalized.includes("part order") ||
    normalized.includes("additional part")
  ) {
    return "PART_ORDER";
  }

  if (normalized.includes("observation")) {
    return "UNDER_OBSERVATION";
  }

  // The engineer slipped the visit — its own column, next to CX Reschedule.
  if (normalized.includes("engineer delay") || normalized.includes("eng delay")) {
    return "ENGINEER_DELAY";
  }

  // The customer pushed the visit out: "CX Pending" in this team's vocabulary,
  // plus explicit reschedules.
  if (
    normalized.includes("cx pending") ||
    normalized.includes("reschedule") ||
    normalized.includes("reshedule")
  ) {
    return "CX_RESCHEDULE";
  }

  return "ATTENDED_OTHER";
}

/**
 * The day-scoped bucket for one row, or null when the row is NOT part of the
 * day's plan (not booked / no usable status).
 *
 * Scheduled-gate rule: ONLY calls whose Morning/current status is at the
 * scheduling stage are in the day's plan. Everything else — untouched carried
 * backlog AND unplanned work (a today Evening entry or a same-day closure on a
 * call that was never Scheduled) — is excluded, so Assigned is exactly the
 * booked set. For planned calls the Evening (today) status or a same-day
 * closure decides the outcome; the Morning status never feeds an outcome
 * bucket.
 */
export function resolveDayScopedProductivityBucket(
  row: ProductivityReportRow,
): ProductivityBucket | null {
  // The plan gate: the Morning/current status must be a scheduling status.
  // A same-day-closed synthetic row keeps the RTPL status it had before the
  // ticket vanished from the Flex WIP, so a Scheduled call that closed today
  // still passes this gate.
  const morningBucket = classifyProductivityStatus(
    morningProductivityStatus(row.output),
  );
  if (morningBucket !== "SCHEDULED") {
    return null;
  }

  // Most calls close by DISAPPEARING from the Flex WIP (closed in HP's
  // system). On the rows this calculation sees (Records-page-visible), a
  // closed synthetic row IS a same-day closure — the engineer completed the
  // booked call today regardless of what the status columns say.
  if (row.carryForward.closedSyntheticRow || row.carryForward.sameDayClosedRow) {
    return "CLOSED";
  }

  // Worked today: a today Evening entry, whatever it says. (Includes an
  // Evening explicitly set back to a scheduling status -> booked, not worked.)
  const evening = eveningProductivityStatus(row.output);
  if (evening) {
    return classifyProductivityStatus(evening);
  }

  // Booked and untouched today: Assigned only.
  return "SCHEDULED";
}

export interface ProductivityBucketCounts {
  assigned: number;
  attended: number;
  closed: number;
  partOrdered: number;
  underObservation: number;
  cxReschedule: number;
  engineerDelay: number;
  assignedTickets: string[];
  attendedTickets: string[];
  closedTickets: string[];
  partOrderedTickets: string[];
  underObservationTickets: string[];
  cxRescheduleTickets: string[];
  engineerDelayTickets: string[];
}

export function emptyProductivityBucketCounts(): ProductivityBucketCounts {
  return {
    assigned: 0,
    attended: 0,
    closed: 0,
    partOrdered: 0,
    underObservation: 0,
    cxReschedule: 0,
    engineerDelay: 0,
    assignedTickets: [],
    attendedTickets: [],
    closedTickets: [],
    partOrderedTickets: [],
    underObservationTickets: [],
    cxRescheduleTickets: [],
    engineerDelayTickets: [],
  };
}

/**
 * Add one bucketed call to an engineer's counts.
 *
 *   Assigned = every counted call — once a call enters the day's plan it stays
 *              Assigned as its status progresses ("remains same").
 *   Attended = every status after the Scheduled stage except the two
 *              non-attendance outcomes (CX Reschedule, Engineer Delay); the
 *              Closed / Part ordered / Under Observation columns are its
 *              named sub-counts.
 */
export function addToProductivityCounts(
  counts: ProductivityBucketCounts,
  bucket: ProductivityBucket,
  ticketId: string,
): void {
  counts.assigned += 1;
  counts.assignedTickets.push(ticketId);

  // Booked, nothing happened yet: assigned only.
  if (bucket === "SCHEDULED") {
    return;
  }

  if (bucket === "CX_RESCHEDULE") {
    counts.cxReschedule += 1;
    counts.cxRescheduleTickets.push(ticketId);
    return;
  }

  if (bucket === "ENGINEER_DELAY") {
    counts.engineerDelay += 1;
    counts.engineerDelayTickets.push(ticketId);
    return;
  }

  counts.attended += 1;
  counts.attendedTickets.push(ticketId);

  if (bucket === "CLOSED") {
    counts.closed += 1;
    counts.closedTickets.push(ticketId);
  } else if (bucket === "PART_ORDER") {
    counts.partOrdered += 1;
    counts.partOrderedTickets.push(ticketId);
  } else if (bucket === "UNDER_OBSERVATION") {
    counts.underObservation += 1;
    counts.underObservationTickets.push(ticketId);
  }
}

// Manual engineer-name aliases. The calculation already merges pure casing
// differences automatically — e.g. "sriram" and "Sriram" collapse into one
// engineer without any entry here. This map is ONLY for genuinely different
// spellings that refer to the same person (e.g. "Lava Kumar" and "Lava").
//   KEY:   the variant as it appears in the report — lower-cased and trimmed.
//   VALUE: the canonical engineer name to show.
// Only add pairs you are CERTAIN are the same engineer — a wrong entry
// silently merges two different engineers' numbers.
export const ENGINEER_NAME_ALIASES: Readonly<Record<string, string>> = {
  "lava kumar": "Lava",
};

/**
 * Resolve a raw engineer name to its canonical form: an explicit alias when one
 * exists, otherwise the trimmed name as-is. Casing is handled by the caller.
 */
export function canonicalEngineerName(rawName: string): string {
  const trimmed = rawName.trim();
  return ENGINEER_NAME_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

function isRequestToCancelValue(value: unknown): boolean {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, " ") === "request to cancel"
  );
}

/**
 * The rows productivity reads — the same set the Records page shows for the
 * day: open calls plus same-day closures; older synthetic closures and
 * Request-to-Cancel rows are out.
 */
export function isProductivityVisibleRow(row: ProductivityReportRow): boolean {
  const recordsVisible =
    !row.carryForward.closedSyntheticRow ||
    row.carryForward.sameDayClosedRow === true;
  return (
    recordsVisible &&
    !isRequestToCancelValue(row.output["Flex Status"]) &&
    !isRequestToCancelValue(row.comparison?.previousFlexStatus)
  );
}

export interface EngineerProductivityEntry {
  name: string;
  regionCode: string;
  regionName: string;
  assigned: number;
  assignedTickets: string[];
  attended: number;
  attendedTickets: string[];
  closed: number;
  closedTickets: string[];
  partOrdered: number;
  partOrderedTickets: string[];
  underObservation: number;
  underObservationTickets: string[];
  cxReschedule: number;
  cxRescheduleTickets: string[];
  engineerDelay: number;
  engineerDelayTickets: string[];
}

/** JSON-serializable — persisted verbatim as a region's frozen EOD snapshot. */
export interface EngineerProductivityResult {
  list: EngineerProductivityEntry[];
  totalAttended: number;
}

export interface ComputeEngineerProductivityOptions {
  /**
   * Restrict to rows whose Work Location (ASP code) is in this set. null or
   * undefined = all regions. Compared upper-cased.
   */
  regionAspCodes?: readonly string[] | null;
}

/**
 * The single source of truth for the per-engineer productivity table.
 * Pure: rows in, per-engineer day-scoped buckets out.
 */
export function computeEngineerProductivity(
  rows: readonly ProductivityReportRow[],
  options: ComputeEngineerProductivityOptions = {},
): EngineerProductivityResult {
  const wantedAspCodes = options.regionAspCodes
    ? new Set(options.regionAspCodes.map((code) => code.trim().toUpperCase()))
    : null;

  let scopedRows = rows.filter(isProductivityVisibleRow);
  if (wantedAspCodes) {
    scopedRows = scopedRows.filter((row) =>
      wantedAspCodes.has(
        String(row.output["Work Location"] ?? "").trim().toUpperCase(),
      ),
    );
  }

  // Deduplicate by Ticket ID so a duplicated row can never double-count.
  const seenTickets = new Set<string>();
  scopedRows = scopedRows.filter((row) => {
    const ticketId = String(row.output["Ticket ID"] ?? "").trim();
    const key =
      ticketId && ticketId !== PRODUCTIVITY_MANUAL_PLACEHOLDER
        ? ticketId
        : String(row.serialNo);
    if (seenTickets.has(key)) return false;
    seenTickets.add(key);
    return true;
  });

  interface EngineerAccumulator {
    casingCounts: Map<string, number>;
    regionCode: string;
    counts: ProductivityBucketCounts;
  }

  const engineersByKey = new Map<string, EngineerAccumulator>();
  for (const row of scopedRows) {
    // Resolve the raw Engineer value to its canonical name: apply manual
    // aliases ("Lava Kumar" -> "Lava") then group case-insensitively so pure
    // casing variants ("sriram"/"Sriram") merge too.
    const name = canonicalEngineerName(String(row.output.Engineer ?? ""));
    if (!name || name === PRODUCTIVITY_MANUAL_PLACEHOLDER) continue;

    // null = not in the day's plan (untouched carried backlog) — excluded.
    const bucket = resolveDayScopedProductivityBucket(row);
    if (bucket === null) continue;

    const key = name.toLowerCase();
    let engineer = engineersByKey.get(key);
    if (!engineer) {
      engineer = {
        casingCounts: new Map(),
        regionCode: String(row.output["Work Location"] ?? "").trim(),
        counts: emptyProductivityBucketCounts(),
      };
      engineersByKey.set(key, engineer);
    }
    engineer.casingCounts.set(name, (engineer.casingCounts.get(name) ?? 0) + 1);

    const ticketId =
      String(row.output["Ticket ID"] ?? "").trim() || String(row.serialNo);
    addToProductivityCounts(engineer.counts, bucket, ticketId);
  }

  const list = Array.from(engineersByKey.values())
    .map((engineer) => {
      // Most frequent spelling wins; ties keep the first seen (Map is ordered).
      let engName = "";
      let bestCount = -1;
      for (const [casing, count] of engineer.casingCounts) {
        if (count > bestCount) {
          bestCount = count;
          engName = casing;
        }
      }

      const regionCode = engineer.regionCode;
      const regionName =
        ASP_CODE_REGION_MAP[regionCode] || regionCode || "N/A";

      return {
        name: engName,
        regionCode,
        regionName,
        ...engineer.counts,
      };
    })
    .sort((a, b) => b.attended - a.attended || a.name.localeCompare(b.name));

  const totalAttended = list.reduce((sum, item) => sum + item.attended, 0);

  return { list, totalAttended };
}

/**
 * Merge per-engineer lists computed separately (e.g. live regions + frozen
 * snapshot regions) into one table. Engineers are merged case-insensitively by
 * canonical name; counts add up and ticket lists concatenate.
 */
export function mergeEngineerProductivityResults(
  results: readonly EngineerProductivityResult[],
): EngineerProductivityResult {
  const merged = new Map<string, EngineerProductivityEntry>();

  for (const result of results) {
    for (const entry of result.list) {
      const key = entry.name.toLowerCase();
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          ...entry,
          assignedTickets: [...entry.assignedTickets],
          attendedTickets: [...entry.attendedTickets],
          closedTickets: [...entry.closedTickets],
          partOrderedTickets: [...entry.partOrderedTickets],
          underObservationTickets: [...entry.underObservationTickets],
          cxRescheduleTickets: [...entry.cxRescheduleTickets],
          engineerDelayTickets: [...entry.engineerDelayTickets],
        });
        continue;
      }

      existing.assigned += entry.assigned;
      existing.attended += entry.attended;
      existing.closed += entry.closed;
      existing.partOrdered += entry.partOrdered;
      existing.underObservation += entry.underObservation;
      existing.cxReschedule += entry.cxReschedule;
      existing.engineerDelay += entry.engineerDelay;
      existing.assignedTickets.push(...entry.assignedTickets);
      existing.attendedTickets.push(...entry.attendedTickets);
      existing.closedTickets.push(...entry.closedTickets);
      existing.partOrderedTickets.push(...entry.partOrderedTickets);
      existing.underObservationTickets.push(...entry.underObservationTickets);
      existing.cxRescheduleTickets.push(...entry.cxRescheduleTickets);
      existing.engineerDelayTickets.push(...entry.engineerDelayTickets);
    }
  }

  const list = Array.from(merged.values()).sort(
    (a, b) => b.attended - a.attended || a.name.localeCompare(b.name),
  );

  return {
    list,
    totalAttended: list.reduce((sum, item) => sum + item.attended, 0),
  };
}
