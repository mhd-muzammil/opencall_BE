import ExcelJS from "exceljs";

/**
 * Reads the uploaded Flex WIP workbook and reduces it to the unique serials that
 * need a warranty lookup.
 *
 * The sheet layout drifts between Flex exports (older files put `Product Number`
 * in column J), so the serial/product columns are located by *header text* and
 * only fall back to the fixed J/K positions when the headers are missing.
 */

/** Header labels, matched case/whitespace-insensitively. */
const SERIAL_HEADER = "product serial no";
const PRODUCT_HEADER = "product number";

/** Fallback positions when the headers cannot be found: J and K. */
const FALLBACK_SERIAL_COLUMN = 10;
const FALLBACK_PRODUCT_COLUMN = 11;
const FALLBACK_HEADER_ROW = 1;

/** How far down we look for the header row. */
const MAX_HEADER_SCAN_ROWS = 15;

/**
 * Junk placeholder Flex writes when a unit has no serial (e.g. `A9T81B NOSN`).
 * These are never sent to HP.
 */
const NOSN_PATTERN = /(^|[\s_-])NOSN([\s_-]|$)/i;

export interface WarrantySerialCandidate {
  /** Normalized serial. Empty string is the blank-serial bucket. */
  serial: string;
  /** Column K with the `#...` localization suffix stripped (`4WF66A#ACJ` → `4WF66A`). */
  productNumber: string | null;
  /** True for blank cells and `NOSN` junk — these resolve to `NO_SERIAL` without hitting HP. */
  isNoSerial: boolean;
  /** How many data rows carry this serial. */
  rowCount: number;
}

export interface SerialExtractionResult {
  sheetName: string;
  headerRow: number;
  serialColumn: number;
  productColumn: number;
  /** Number of data rows below the header. */
  totalRows: number;
  /** Unique serials, in first-seen order. */
  candidates: WarrantySerialCandidate[];
}

/**
 * HP product numbers carry a localization suffix after `#` (`#ACJ`, `#460`,
 * `#AB2`, ...). HP's warranty form wants the base product number only.
 */
export function stripProductSuffix(
  value: string | null | undefined,
): string | null {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }

  const hashIndex = text.indexOf("#");
  const base = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
  return base.trim() || null;
}

/** Blank cells and `NOSN` placeholders are `NO_SERIAL`; they never reach HP. */
export function isNoSerialValue(value: string | null | undefined): boolean {
  const text = String(value ?? "").trim();
  if (!text) {
    return true;
  }

  return NOSN_PATTERN.test(text);
}

/** Trim, collapse internal whitespace, upper-case — the cache key form. */
export function normalizeSerial(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

/**
 * Flattens an ExcelJS cell value to plain text. Cells can hold rich text,
 * hyperlinks, formula results, dates or numbers depending on how Flex exported.
 */
export function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("");
    }
    if ("text" in value && typeof value.text === "string") {
      return value.text;
    }
    if ("result" in value) {
      return cellText(value.result as ExcelJS.CellValue);
    }
  }

  return "";
}

function normalizeHeader(value: ExcelJS.CellValue): string {
  return cellText(value).trim().replace(/\s+/g, " ").toLowerCase();
}

export interface HeaderLocation {
  headerRow: number;
  serialColumn: number;
  productColumn: number;
}

export function locateHeaders(worksheet: ExcelJS.Worksheet): HeaderLocation {
  const lastRow = Math.min(worksheet.rowCount, MAX_HEADER_SCAN_ROWS);

  for (let rowNumber = 1; rowNumber <= lastRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    let serialColumn = 0;
    let productColumn = 0;

    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const header = normalizeHeader(cell.value);
      if (header === SERIAL_HEADER && serialColumn === 0) {
        serialColumn = columnNumber;
      } else if (header === PRODUCT_HEADER && productColumn === 0) {
        productColumn = columnNumber;
      }
    });

    // The serial column is what we cannot work without; the product number is
    // only needed when HP asks to disambiguate the model.
    if (serialColumn > 0) {
      return {
        headerRow: rowNumber,
        serialColumn,
        productColumn: productColumn > 0 ? productColumn : FALLBACK_PRODUCT_COLUMN,
      };
    }
  }

  return {
    headerRow: FALLBACK_HEADER_ROW,
    serialColumn: FALLBACK_SERIAL_COLUMN,
    productColumn: FALLBACK_PRODUCT_COLUMN,
  };
}

export function selectWorksheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet {
  const named = workbook.getWorksheet("Report");
  if (named) {
    return named;
  }

  const first = workbook.worksheets[0];
  if (!first) {
    throw new Error("Workbook contains no worksheets");
  }

  return first;
}

export async function extractSerials(
  filePath: string,
): Promise<SerialExtractionResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const worksheet = selectWorksheet(workbook);
  const { headerRow, serialColumn, productColumn } = locateHeaders(worksheet);

  const candidates = new Map<string, WarrantySerialCandidate>();
  let totalRows = 0;

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRow) {
      return;
    }

    totalRows += 1;

    const serial = normalizeSerial(cellText(row.getCell(serialColumn).value));
    const productNumber = stripProductSuffix(
      cellText(row.getCell(productColumn).value),
    );

    const existing = candidates.get(serial);
    if (existing) {
      existing.rowCount += 1;
      // Keep the first product number we see; later rows for the same serial
      // occasionally leave column K blank.
      existing.productNumber ??= productNumber;
      return;
    }

    candidates.set(serial, {
      serial,
      productNumber,
      isNoSerial: isNoSerialValue(serial),
      rowCount: 1,
    });
  });

  return {
    sheetName: worksheet.name,
    headerRow,
    serialColumn,
    productColumn,
    totalRows,
    candidates: [...candidates.values()],
  };
}
