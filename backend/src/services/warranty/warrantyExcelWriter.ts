import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import type { WarrantyLookupStatus } from "@opencall/shared";
import {
  cellText,
  locateHeaders,
  normalizeSerial,
  selectWorksheet,
} from "./serialExtractor.js";

/**
 * Writes the warranty columns into a *copy* of the uploaded workbook.
 *
 * The source file is opened read-only and is never written back to — the output
 * always goes to a different path, so the original upload stays byte-identical.
 * ExcelJS (rather than SheetJS) is used here so the existing cells keep their
 * formatting exactly.
 */

/** Column AX — the warranty end date, formatted `DD.MM.YYYY`. */
export const WARRANTY_STATUS_COLUMN = 50;
/** Column AY — the per-serial lookup outcome. */
export const LOOKUP_STATUS_COLUMN = 51;

export const WARRANTY_STATUS_HEADER = "Warranty Status";
export const LOOKUP_STATUS_HEADER = "_Lookup Status";

export interface WarrantyRowResult {
  lookupStatus: WarrantyLookupStatus;
  /** ISO `YYYY-MM-DD`, or null. */
  endDate: string | null;
}

/** ISO `YYYY-MM-DD` → `DD.MM.YYYY`. Null/blank/unparseable → empty cell. */
export function formatWarrantyDate(iso: string | null | undefined): string {
  const text = String(iso ?? "").trim();
  if (!text) {
    return "";
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    return "";
  }

  return `${match[3]}.${match[2]}.${match[1]}`;
}

export interface WriteWarrantyWorkbookInput {
  sourceFilePath: string;
  outputFilePath: string;
  /** Keyed by normalized serial; the blank-serial bucket is the empty string. */
  resultsBySerial: ReadonlyMap<string, WarrantyRowResult>;
}

export interface WriteWarrantyWorkbookResult {
  outputFilePath: string;
  /** Data rows that received a warranty result. */
  rowsWritten: number;
}

export async function writeWarrantyWorkbook(
  input: WriteWarrantyWorkbookInput,
): Promise<WriteWarrantyWorkbookResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(input.sourceFilePath);

  const worksheet = selectWorksheet(workbook);
  const { headerRow, serialColumn } = locateHeaders(worksheet);

  const header = worksheet.getRow(headerRow);
  header.getCell(WARRANTY_STATUS_COLUMN).value = WARRANTY_STATUS_HEADER;
  header.getCell(LOOKUP_STATUS_COLUMN).value = LOOKUP_STATUS_HEADER;
  header.commit();

  let rowsWritten = 0;

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRow) {
      return;
    }

    const serial = normalizeSerial(cellText(row.getCell(serialColumn).value));
    const result = input.resultsBySerial.get(serial);
    if (!result) {
      return;
    }

    row.getCell(WARRANTY_STATUS_COLUMN).value = formatWarrantyDate(result.endDate);
    row.getCell(LOOKUP_STATUS_COLUMN).value = result.lookupStatus;
    row.commit();
    rowsWritten += 1;
  });

  await fs.promises.mkdir(path.dirname(input.outputFilePath), { recursive: true });
  await workbook.xlsx.writeFile(input.outputFilePath);

  return {
    outputFilePath: input.outputFilePath,
    rowsWritten,
  };
}
