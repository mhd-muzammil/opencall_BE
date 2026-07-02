import {
  SOURCE_COLUMN_REQUIREMENTS,
  type RequiredColumnDefinition,
  type UploadSourceType,
} from "@opencall/shared";
import xlsx from "xlsx";
import {
  buildHeaderAliasMap,
  displayHeader,
  normalizeHeader,
} from "../normalization/headerNormalizer.js";

const MAX_HEADER_SCAN_ROWS = 25;

export interface ExcelDataRow {
  rowNumber: number;
  values: Record<string, unknown>;
  rawRow: Record<string, unknown>;
}

export interface ExcelSheetReadResult {
  headerRowNumber: number | null;
  detectedHeaders: string[];
  missingColumns: string[];
  rows: ExcelDataRow[];
}



function findHeaderRowIndex(
  rows: readonly unknown[][],
  requiredColumns: readonly RequiredColumnDefinition[],
): { index: number; score: number } {
  const aliasMap = buildHeaderAliasMap(requiredColumns);

  let bestIndex = -1;
  let bestScore = 0;

  rows.slice(0, MAX_HEADER_SCAN_ROWS).forEach((row, index) => {
    const score = row.filter((cell) =>
      aliasMap.has(normalizeHeader(cell)),
    ).length;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return { index: bestIndex, score: bestScore };
}

interface ProcessedSheet extends ExcelSheetReadResult {
  score: number;
}

/**
 * Detects the header row within a single sheet's raw rows and builds the
 * canonicalized data rows below it. Returns `headerRowNumber: null` (and no
 * rows) when the sheet has no recognizable header for the given source type,
 * which lets callers skip non-data sheets (summaries, pivots, etc.).
 */
function processSheet(
  rawRows: readonly unknown[][],
  requiredColumns: readonly RequiredColumnDefinition[],
): ProcessedSheet {
  const { index: headerRowIndex, score } = findHeaderRowIndex(
    rawRows,
    requiredColumns,
  );

  if (headerRowIndex < 0) {
    return {
      headerRowNumber: null,
      detectedHeaders: [],
      missingColumns: requiredColumns.map((column) => column.canonical),
      rows: [],
      score: 0,
    };
  }

  const headerRow = rawRows[headerRowIndex] ?? [];
  const detectedHeaders = headerRow.map(displayHeader);
  const normalizedHeaderSet = new Set(detectedHeaders.map(normalizeHeader));
  const missingColumns = requiredColumns
    .filter((column) => {
      return !column.aliases.some((alias) =>
        normalizedHeaderSet.has(normalizeHeader(alias)),
      );
    })
    .map((column) => column.canonical);

  const aliasMap = buildHeaderAliasMap(requiredColumns);
  const rows = rawRows
    .slice(headerRowIndex + 1)
    .map<ExcelDataRow | null>((row, index) => {
      const values: Record<string, unknown> = {};
      const rawRow: Record<string, unknown> = {};
      let hasAnyValue = false;

      row.forEach((cell, columnIndex) => {
        const rawHeader = displayHeader(headerRow[columnIndex]);
        const canonicalHeader =
          aliasMap.get(normalizeHeader(rawHeader)) || rawHeader;

        if (!canonicalHeader) {
          return;
        }

        rawRow[rawHeader] = cell;
        values[canonicalHeader] = cell;

        if (displayHeader(cell).length > 0) {
          hasAnyValue = true;
        }
      });

      if (!hasAnyValue) {
        return null;
      }

      return {
        rowNumber: headerRowIndex + index + 2,
        values,
        rawRow,
      };
    })
    .filter((row): row is ExcelDataRow => row !== null);

  return {
    headerRowNumber: headerRowIndex + 1,
    detectedHeaders: detectedHeaders.filter(Boolean),
    missingColumns,
    rows,
    score,
  };
}

export function readExcelSheet(
  filePath: string,
  sourceType: UploadSourceType,
): ExcelSheetReadResult {
  const workbook = xlsx.readFile(filePath, {
    cellDates: true,
    raw: false,
  });
  const requiredColumns = SOURCE_COLUMN_REQUIREMENTS[sourceType];

  const emptyResult: ExcelSheetReadResult = {
    headerRowNumber: null,
    detectedHeaders: [],
    missingColumns: requiredColumns.map((column) => column.canonical),
    rows: [],
  };

  const readRawRows = (sheetName: string): unknown[][] => {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      return [];
    }
    return xlsx.utils.sheet_to_json<unknown[]>(worksheet, {
      header: 1,
      blankrows: false,
      defval: "",
    });
  };

  if (sourceType === "CALL_PLAN") {
    // A Call Plan workbook may split allocations across multiple sheets — e.g.
    // one sheet per region. Merge the data rows from every sheet that has a
    // recognizable header so no region's engineer allocations are dropped.
    // Sheets without call-plan headers (summaries, pivots) score 0 and are
    // skipped; duplicate tickets across sheets are removed downstream by
    // dedupeRowsByTicket before matching.
    const sheets = workbook.SheetNames
      .map((name) => processSheet(readRawRows(name), requiredColumns))
      .filter((sheet) => sheet.headerRowNumber !== null && sheet.rows.length > 0);

    if (sheets.length === 0) {
      return emptyResult;
    }

    // A required column counts as present when ANY merged sheet supplies it.
    const detectedHeaders = Array.from(
      new Set(sheets.flatMap((sheet) => sheet.detectedHeaders)),
    );
    const normalizedHeaderSet = new Set(detectedHeaders.map(normalizeHeader));
    const missingColumns = requiredColumns
      .filter((column) => {
        return !column.aliases.some((alias) =>
          normalizedHeaderSet.has(normalizeHeader(alias)),
        );
      })
      .map((column) => column.canonical);

    return {
      headerRowNumber: sheets[0]?.headerRowNumber ?? null,
      detectedHeaders,
      missingColumns,
      rows: sheets.flatMap((sheet) => sheet.rows),
    };
  }

  // Non-Call-Plan sources: pick the single best-scoring sheet.
  let best: ProcessedSheet | null = null;
  for (const sheetName of workbook.SheetNames) {
    const sheet = processSheet(readRawRows(sheetName), requiredColumns);
    if (!best || sheet.score > best.score) {
      best = sheet;
    }
  }

  if (!best || best.headerRowNumber === null) {
    return emptyResult;
  }

  return {
    headerRowNumber: best.headerRowNumber,
    detectedHeaders: best.detectedHeaders,
    missingColumns: best.missingColumns,
    rows: best.rows,
  };
}
