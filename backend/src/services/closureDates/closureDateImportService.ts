import xlsx from "xlsx";
import {
  mergeCaseClosureDates,
  recordClosureSyncRun,
  replaceCaseClosureDates,
  type CaseClosureRecordInput,
} from "../../repositories/caseClosureDateRepository.js";
import {
  classifyClosureStatus,
  tallyClosureStatuses,
  type ClosureStatusTally,
} from "./closureStatusClassify.js";
import { badRequest } from "../../utils/httpError.js";

/**
 * Parses a Flex Closure ASP Report workbook into one record per work order and stores it,
 * keyed by WO id (Ticket No) and Case id. Only display-safe external data is stored —
 * nothing here touches report rows or any existing table.
 *
 * Columns read (case-insensitive, trimmed): Ticket No, Case Id, Status, Status Remarks,
 * Closure Date, Failure Code, Resolution comments, Work Location, ASP Name, Activity Time.
 *
 * Two things the source file forces on us:
 *
 *  1. It emits one row PER PART ORDER, not per work order — 60 rows for 48 work orders in
 *     one sample, 5 rows for a single WO in another. Rows are collapsed by work order,
 *     choosing deterministically (see `beats`).
 *  2. A "Closed - Canceled" row has a BLANK Closure Date. Those rows are closed in Flex
 *     and are stored, with `closureDate = null` and `closedOn` taken from Activity Time.
 */

export type ClosureImportMode = "replace" | "merge";

export interface ClosureDateImportResult {
  /** Data rows in the workbook. */
  totalRows: number;
  /** Distinct work orders after collapsing the per-part-order rows. */
  workOrders: number;
  /** Records actually written. */
  imported: number;
  /** Rows with neither a Ticket No nor a Case Id — nothing to match on. */
  skippedNoKey: number;
  /** Stored records whose Closure Date was blank (cancellations). */
  withoutClosureDate: number;
  /**
   * Always 0 now. Kept so the existing import UI keeps type-checking: a missing closure
   * date is no longer a reason to drop a row.
   */
  skippedNoDate: number;
  byStatus: ClosureStatusTally;
  mode: ClosureImportMode;
}

/** Finds a value by header name, case-insensitively and trim-insensitively. */
function pick(row: Record<string, unknown>, header: string): unknown {
  const target = header.trim().toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.trim().toLowerCase() === target) {
      return row[key];
    }
  }
  return undefined;
}

/** First non-blank value among several candidate header spellings. */
function pickAny(row: Record<string, unknown>, ...headers: string[]): unknown {
  for (const header of headers) {
    const value = pick(row, header);
    if (value !== undefined && String(value).trim() !== "") return value;
  }
  return undefined;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

interface SheetDateParts {
  y: number;
  m: number;
  d: number;
  H: number;
  M: number;
  S: number;
}

/**
 * Reads a date/time cell into plain calendar components — deliberately WITHOUT ever
 * building a JS `Date` from a serial.
 *
 * The workbook's timestamps are IST wall-clock. `xlsx.SSF.parse_date_code` decodes an
 * Excel serial into exactly those components with no timezone involved, so an Activity
 * Time of 00:31 stays on its own day. The previous implementation went through a JS
 * `Date` and `getFullYear()/getMonth()/getDate()`, which reads the CONTAINER's local
 * time — UTC in production — and rolled early-morning rows back to the previous day.
 */
function parseSheetDate(value: unknown): SheetDateParts | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = xlsx.SSF.parse_date_code(value);
    if (!parsed || !parsed.y || parsed.y < 1900) return null;
    return {
      y: parsed.y,
      m: parsed.m,
      d: parsed.d,
      H: parsed.H,
      M: parsed.M,
      S: Math.floor(parsed.S),
    };
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // Defensive only — `readWorkbookRows` reads serials, not Dates. Local getters are
    // right here because both the API and the worker containers run TZ=Asia/Kolkata.
    return {
      y: value.getFullYear(),
      m: value.getMonth() + 1,
      d: value.getDate(),
      H: value.getHours(),
      M: value.getMinutes(),
      S: value.getSeconds(),
    };
  }

  const raw = text(value);
  if (!raw) return null;

  const time = /[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  const H = time ? Number(time[1]) : 0;
  const M = time ? Number(time[2]) : 0;
  const S = time?.[3] ? Number(time[3]) : 0;

  // DD-MM-YYYY or DD/MM/YYYY
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(raw);
  if (dmy) {
    return { y: Number(dmy[3]), m: Number(dmy[2]), d: Number(dmy[1]), H, M, S };
  }
  // YYYY-MM-DD
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (iso) {
    return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]), H, M, S };
  }
  return null;
}

/** YYYY-MM-DD in the workbook's own (IST) calendar. Exported for the timezone tests. */
export function toIsoDate(value: unknown): string | null {
  const parts = parseSheetDate(value);
  if (!parts) return null;
  return `${parts.y}-${pad(parts.m)}-${pad(parts.d)}`;
}

/**
 * The cell's wall clock stamped with the IST offset, e.g. "2026-07-31T00:31:00+05:30".
 * Postgres then stores the correct instant in a TIMESTAMPTZ regardless of server TZ.
 */
export function toIstTimestamp(value: unknown): string | null {
  const parts = parseSheetDate(value);
  if (!parts) return null;
  return (
    `${parts.y}-${pad(parts.m)}-${pad(parts.d)}` +
    `T${pad(parts.H)}:${pad(parts.M)}:${pad(parts.S)}+05:30`
  );
}

/** Sortable integer for "latest Activity Time wins"; null sorts lowest. */
function sortableStamp(parts: SheetDateParts | null): number {
  if (!parts) return -1;
  return (
    parts.y * 1e10 +
    parts.m * 1e8 +
    parts.d * 1e6 +
    parts.H * 1e4 +
    parts.M * 1e2 +
    parts.S
  );
}

interface Candidate {
  record: CaseClosureRecordInput;
  hasClosureDate: boolean;
  activityStamp: number;
}

/**
 * Deterministic winner between two rows of the same work order:
 *   1. a row that carries a Closure Date beats one that does not
 *   2. then the later Activity Time
 *   3. then file order (the incumbent, i.e. the earlier row, keeps the slot)
 *
 * The old code scanned backwards and let the LAST occurrence win, which on real data
 * picked a part-order row with a blank Failure Code over the row that had one.
 */
function beats(candidate: Candidate, incumbent: Candidate): boolean {
  if (candidate.hasClosureDate !== incumbent.hasClosureDate) {
    return candidate.hasClosureDate;
  }
  return candidate.activityStamp > incumbent.activityStamp;
}

export function readWorkbookRows(filePath: string): Array<Record<string, unknown>> {
  // Every failure below is a BAD UPLOAD, not a server fault, and is reported as such
  // with the real reason. The unhandled-error path returns a deliberately opaque
  // "Unexpected server error", which left the auto-sync worker able to log only
  // "import returned 500" — true, and useless.
  let workbook: ReturnType<typeof xlsx.readFile>;
  try {
    // `cellDates: false` + `raw: true` keeps date cells as Excel serials so
    // `parseSheetDate` can decode them timezone-free, and keeps ids as their literal
    // values rather than number-formatted text.
    workbook = xlsx.readFile(filePath, { cellDates: false, raw: true });
  } catch (error) {
    // A vendor error page, a truncated download or an empty export all arrive here as
    // bytes that simply are not a workbook.
    throw badRequest(
      `Could not read the closure workbook: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { field: "closureReport" },
    );
  }

  const sheetName =
    workbook.SheetNames.find((n) => n.toLowerCase() === "report") ??
    workbook.SheetNames[0];
  if (!sheetName) {
    throw badRequest("The closure workbook has no sheets", {
      field: "closureReport",
    });
  }
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) {
    throw badRequest(`Closure workbook sheet "${sheetName}" is empty`, {
      field: "closureReport",
    });
  }
  return xlsx.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: "" });
}

export interface ParsedClosureWorkbook {
  records: CaseClosureRecordInput[];
  totalRows: number;
  skippedNoKey: number;
}

/**
 * Collapses the workbook's part-order rows into one record per work order. Exported so
 * the unit tests can exercise the collapse without touching a database.
 */
export function parseClosureRows(
  rows: readonly Record<string, unknown>[],
  importSource: string,
): ParsedClosureWorkbook {
  const byKey = new Map<string, Candidate>();
  const order: string[] = [];
  let skippedNoKey = 0;

  for (const row of rows) {
    const woId = text(pickAny(row, "Ticket No", "Ticket Number", "WO ID"));
    const caseId = text(pickAny(row, "Case Id", "Case ID"));
    if (!woId && !caseId) {
      skippedNoKey += 1;
      continue;
    }

    const closureDate = toIsoDate(pick(row, "Closure Date"));
    const activityParts = parseSheetDate(pick(row, "Activity Time"));
    const activityIso = activityParts
      ? `${activityParts.y}-${pad(activityParts.m)}-${pad(activityParts.d)}`
      : null;

    const candidate: Candidate = {
      hasClosureDate: Boolean(closureDate),
      activityStamp: sortableStamp(activityParts),
      record: {
        woId,
        caseId,
        closureDate,
        // The day this closure is counted under: the closure date when Flex gave one,
        // otherwise the day the closing activity happened.
        closedOn: closureDate ?? activityIso,
        closureStatus: text(pickAny(row, "Status", "Closure Status", "Call Status")),
        statusRemarks: text(pick(row, "Status Remarks")),
        failureCode: text(pick(row, "Failure Code")),
        resolutionComments: text(
          pickAny(row, "Resolution comments", "Resolution Comments"),
        ),
        workLocation: text(pick(row, "Work Location")).toUpperCase(),
        aspName: text(pickAny(row, "ASP Name", "ASP")),
        activityTime: toIstTimestamp(pick(row, "Activity Time")),
        importSource,
      },
    };

    // Group by work order; a row with only a Case Id groups under that instead.
    const key = (woId || caseId).trim().toUpperCase();
    const incumbent = byKey.get(key);
    if (!incumbent) {
      byKey.set(key, candidate);
      order.push(key);
      continue;
    }
    if (beats(candidate, incumbent)) {
      byKey.set(key, candidate);
    }
  }

  return {
    records: order.map((key) => byKey.get(key)!.record),
    totalRows: rows.length,
    skippedNoKey,
  };
}

export interface ClosureImportOptions {
  /** `replace` wipes and reloads (the manual button); `merge` touches only these keys. */
  mode?: ClosureImportMode;
  /** Stamped onto every written row: 'MANUAL' (default) or 'AUTO' (the worker). */
  importSource?: string;
}

export async function importClosureDatesFromFile(
  filePath: string,
  options: ClosureImportOptions = {},
): Promise<ClosureDateImportResult> {
  const mode: ClosureImportMode = options.mode === "merge" ? "merge" : "replace";
  const importSource = options.importSource ?? "MANUAL";

  const rows = readWorkbookRows(filePath);
  const { records, totalRows, skippedNoKey } = parseClosureRows(rows, importSource);

  const usableRows = totalRows - skippedNoKey;
  if (usableRows > 0) {
    console.log(
      `[ClosureDates] ${mode} import: ${usableRows} file rows → ${records.length} work orders ` +
        `(collapse ratio ${(usableRows / Math.max(records.length, 1)).toFixed(2)}:1)`,
    );
  }

  // A replace import REPLACES: an empty batch would leave nothing behind. The
  // repository refuses to act on one, and this turns that refusal into a message the
  // person who uploaded actually sees, instead of a silent "imported 0" that looks
  // like success while the closure history is gone.
  if (mode === "replace" && records.length === 0) {
    throw badRequest(
      `No usable rows found in the closure workbook (${totalRows} rows read), so the ` +
        `existing closure data was left untouched. Check the file covers the dates you ` +
        `expect and has its Ticket No / Case Id columns.`,
      { field: "closureReport", totalRows, skippedNoKey },
    );
  }

  const imported =
    mode === "merge"
      ? await mergeCaseClosureDates(records)
      : await replaceCaseClosureDates(records);

  // Record the RUN, imported-0 included: an empty new-day export is a healthy sync,
  // and this is what keeps the freshness badge honest about a live worker. Best-effort
  // (never fails the import) and a no-op until migration 042 exists.
  await recordClosureSyncRun({
    source: importSource,
    mode,
    totalRows,
    imported,
  });

  return {
    totalRows,
    workOrders: records.length,
    imported,
    skippedNoKey,
    withoutClosureDate: records.filter((r) => !r.closureDate).length,
    skippedNoDate: 0,
    byStatus: tallyClosureStatuses(records.map((r) => r.closureStatus)),
    mode,
  };
}

export { classifyClosureStatus };
