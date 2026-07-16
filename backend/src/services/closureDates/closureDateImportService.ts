import xlsx from "xlsx";
import {
  replaceCaseClosureDates,
  type CaseClosureDateInput,
} from "../../repositories/caseClosureDateRepository.js";

/**
 * Parses a Flex Closure ASP Report workbook and stores each row's closure date, keyed by
 * WO id (Ticket No) and Case id. Only display-safe external data is stored — nothing here
 * touches report rows or any existing table.
 *
 * Expected columns (case-insensitive, trimmed): "Ticket No", "Case Id", "Closure Date".
 * Closure Date is an Excel date (read as a JS Date via cellDates); rows without a closure
 * date, or without any usable key, are skipped.
 */

export interface ClosureDateImportResult {
  totalRows: number;
  imported: number;
  skippedNoDate: number;
  skippedNoKey: number;
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

/** Converts a cell that may be a JS Date, an Excel serial, or a string to YYYY-MM-DD. */
function toIsoDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = xlsx.SSF.parse_date_code(value);
    if (!parsed) return null;
    const m = String(parsed.m).padStart(2, "0");
    const d = String(parsed.d).padStart(2, "0");
    return `${parsed.y}-${m}-${d}`;
  }
  const text = String(value ?? "").trim();
  if (!text) return null;
  // DD-MM-YYYY or DD/MM/YYYY
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(text);
  if (dmy) {
    return `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
  }
  // YYYY-MM-DD
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

export async function importClosureDatesFromFile(
  filePath: string,
): Promise<ClosureDateImportResult> {
  const workbook = xlsx.readFile(filePath, { cellDates: true, raw: false });
  const sheetName =
    workbook.SheetNames.find((n) => n.toLowerCase() === "report") ??
    workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error("No sheet found in the closure-date workbook");
  }
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) {
    throw new Error("Closure-date worksheet is undefined");
  }

  const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
    defval: "",
  });

  const inputs: CaseClosureDateInput[] = [];
  let skippedNoDate = 0;
  let skippedNoKey = 0;

  for (const row of rows) {
    const woId = String(pick(row, "Ticket No") ?? "").trim();
    const caseId = String(pick(row, "Case Id") ?? "").trim();
    if (!woId && !caseId) {
      skippedNoKey += 1;
      continue;
    }
    const closureDate = toIsoDate(pick(row, "Closure Date"));
    if (!closureDate) {
      skippedNoDate += 1;
      continue;
    }
    inputs.push({ woId, caseId, closureDate });
  }

  const imported = await replaceCaseClosureDates(inputs);

  return {
    totalRows: rows.length,
    imported,
    skippedNoDate,
    skippedNoKey,
  };
}
