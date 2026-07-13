import type { WarrantyLookupStatus } from "@opencall/shared";

/**
 * Pure parser for HP's warranty result page.
 *
 * HP rewrites its CSS class names regularly, so nothing here selects by class:
 * we read the visible text of the `Additional Information` block and pull the
 * values sitting next to the `End date` and `Status` labels.
 */

export interface ParsedWarrantyResult {
  /** `OK` when an end date was found, `NOT_FOUND` when the page resolved without one. */
  lookupStatus: Extract<WarrantyLookupStatus, "OK" | "NOT_FOUND">;
  /** ISO `YYYY-MM-DD`, or null when HP reported no entitlement. */
  endDate: string | null;
  /** HP's raw "Status" text (e.g. `Active`, `Expired`). */
  hpStatus: string | null;
}

const END_DATE_LABEL = "end date";
const STATUS_LABEL = "status";

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  // Reject impossible calendar dates (e.g. 31 Feb) by round-tripping through Date.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Normalizes the date formats HP renders across locales to ISO `YYYY-MM-DD`.
 * Slash/dot dates are read day-first — the entry point is the `in-en` site.
 */
export function parseHpDate(value: string | null | undefined): string | null {
  const text = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!text) {
    return null;
  }

  // YYYY-MM-DD
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  // Month DD, YYYY  /  Mon DD YYYY
  const monthFirst = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(
    text,
  );
  if (monthFirst) {
    const month = MONTHS[monthFirst[1]!.toLowerCase()];
    if (month) {
      return toIso(Number(monthFirst[3]), month, Number(monthFirst[2]));
    }
  }

  // DD-Mon-YYYY  /  DD Mon YYYY
  const dayFirstMonth = /^(\d{1,2})[-\s]([A-Za-z]+)\.?[-\s](\d{4})$/.exec(text);
  if (dayFirstMonth) {
    const month = MONTHS[dayFirstMonth[2]!.toLowerCase()];
    if (month) {
      return toIso(Number(dayFirstMonth[3]), month, Number(dayFirstMonth[1]));
    }
  }

  // DD/MM/YYYY or DD.MM.YYYY (day-first)
  const numeric = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(text);
  if (numeric) {
    return toIso(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));
  }

  return null;
}

function toLines(pageText: string): string[] {
  return pageText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Finds the value sitting next to a label. HP renders these either as
 * `End date: 5 January 2026` on one line, or as the label and value on
 * consecutive lines.
 */
function readLabelledValue(lines: readonly string[], label: string): string | null {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const normalized = line.toLowerCase();

    if (!normalized.startsWith(label)) {
      continue;
    }

    const remainder = line.slice(label.length).trim();

    // Guard against labels that merely share a prefix ("Status Remarks", and the
    // "Warranty Status" column we ourselves write).
    if (remainder && !remainder.startsWith(":")) {
      continue;
    }

    const inlineValue = remainder.replace(/^:/, "").trim();
    if (inlineValue) {
      return inlineValue;
    }

    const nextLine = lines[index + 1]?.trim();
    return nextLine && nextLine.length > 0 ? nextLine : null;
  }

  return null;
}

export function parseWarrantyResult(pageText: string): ParsedWarrantyResult {
  const lines = toLines(pageText);

  const endDate = parseHpDate(readLabelledValue(lines, END_DATE_LABEL));
  const hpStatus = readLabelledValue(lines, STATUS_LABEL);

  return {
    lookupStatus: endDate ? "OK" : "NOT_FOUND",
    endDate,
    hpStatus,
  };
}
