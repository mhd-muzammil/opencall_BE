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

export function readExcelSheet(
  filePath: string,
  sourceType: UploadSourceType,
): ExcelSheetReadResult {
  const workbook = xlsx.readFile(filePath, {
    cellDates: true,
    raw: false,
  });
  const requiredColumns = SOURCE_COLUMN_REQUIREMENTS[sourceType];

  let bestSheetRawRows: unknown[][] = [];
  let bestHeaderRowIndex = -1;
  let maxScore = -1;

  if (sourceType === "CALL_PLAN") {
    const targetSheet = workbook.SheetNames.find((name) =>
      name.toLowerCase().includes("open"),
    );

    if (!targetSheet) {
      throw new Error("Open Call sheet not found");
    }

    const worksheet = workbook.Sheets[targetSheet];
    if (!worksheet) {
      throw new Error("Open Call worksheet is undefined");
    }

    const rawRows = xlsx.utils.sheet_to_json<unknown[]>(worksheet, {
      header: 1,
      blankrows: false,
      defval: "",
    });

    const { index } = findHeaderRowIndex(rawRows, requiredColumns);

    bestHeaderRowIndex = index;
    bestSheetRawRows = rawRows;
  } else {
    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet) continue;

      const rawRows = xlsx.utils.sheet_to_json<unknown[]>(worksheet, {
        header: 1,
        blankrows: false,
        defval: "",
      });

      const { index, score } = findHeaderRowIndex(rawRows, requiredColumns);

      if (score > maxScore) {
        maxScore = score;
        bestHeaderRowIndex = index;
        bestSheetRawRows = rawRows;
      }
    }
  }

  if (bestHeaderRowIndex < 0) {
    return {
      headerRowNumber: null,
      detectedHeaders: [],
      missingColumns: requiredColumns.map((column) => column.canonical),
      rows: [],
    };
  }

  const rawRows = bestSheetRawRows;
  const headerRowIndex = bestHeaderRowIndex;
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
  };
}
