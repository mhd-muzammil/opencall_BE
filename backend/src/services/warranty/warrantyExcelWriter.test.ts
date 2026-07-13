import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  formatWarrantyDate,
  writeWarrantyWorkbook,
  LOOKUP_STATUS_COLUMN,
  LOOKUP_STATUS_HEADER,
  WARRANTY_STATUS_COLUMN,
  WARRANTY_STATUS_HEADER,
  type WarrantyRowResult,
} from "./warrantyExcelWriter.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("./__fixtures__/flex-wip-sample.xlsx", import.meta.url),
);

const KNOWN_SERIAL = "TH49J5D1FB";
const NOSN_SERIAL = "A9T81B NOSN";

function sha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

describe("formatWarrantyDate", () => {
  it("renders ISO as DD.MM.YYYY", () => {
    expect(formatWarrantyDate("2026-01-05")).toBe("05.01.2026");
    expect(formatWarrantyDate("2025-12-31")).toBe("31.12.2025");
  });

  it("renders an empty cell for anything that is not an ISO date", () => {
    expect(formatWarrantyDate(null)).toBe("");
    expect(formatWarrantyDate(undefined)).toBe("");
    expect(formatWarrantyDate("")).toBe("");
    expect(formatWarrantyDate("05.01.2026")).toBe("");
  });
});

describe("writeWarrantyWorkbook (real Flex WIP workbook)", () => {
  let tempDir: string;
  let outputFilePath: string;
  let sourceHashBefore: string;
  let output: ExcelJS.Worksheet;

  const resultsBySerial = new Map<string, WarrantyRowResult>([
    [KNOWN_SERIAL, { lookupStatus: "OK", endDate: "2026-01-05" }],
    [NOSN_SERIAL, { lookupStatus: "NO_SERIAL", endDate: null }],
  ]);

  beforeAll(async () => {
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "warranty-writer-"),
    );
    outputFilePath = path.join(tempDir, "flex-wip-warranty.xlsx");

    sourceHashBefore = sha256(FIXTURE_PATH);

    await writeWarrantyWorkbook({
      sourceFilePath: FIXTURE_PATH,
      outputFilePath,
      resultsBySerial,
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputFilePath);
    output = workbook.getWorksheet("Report")!;
  });

  afterAll(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it("leaves the source workbook byte-identical", () => {
    expect(sha256(FIXTURE_PATH)).toBe(sourceHashBefore);
  });

  it("writes the output to a different path", () => {
    expect(path.resolve(outputFilePath)).not.toBe(path.resolve(FIXTURE_PATH));
    expect(fs.existsSync(outputFilePath)).toBe(true);
  });

  it("appends the AX and AY headers", () => {
    const header = output.getRow(1);
    expect(header.getCell(WARRANTY_STATUS_COLUMN).value).toBe(
      WARRANTY_STATUS_HEADER,
    );
    expect(header.getCell(LOOKUP_STATUS_COLUMN).value).toBe(LOOKUP_STATUS_HEADER);
    // AX / AY.
    expect(WARRANTY_STATUS_COLUMN).toBe(50);
    expect(LOOKUP_STATUS_COLUMN).toBe(51);
  });

  it("preserves the original 49 columns of data", () => {
    const header = output.getRow(1);
    expect(header.getCell(10).value).toBe("Product Serial No");
    expect(header.getCell(11).value).toBe("Product Number");
    expect(header.getCell(49).value).toBe("Last Updated By");
  });

  it("writes an OK end date as DD.MM.YYYY", () => {
    const row = findRowBySerial(output, KNOWN_SERIAL);

    expect(row.getCell(WARRANTY_STATUS_COLUMN).value).toBe("05.01.2026");
    expect(row.getCell(LOOKUP_STATUS_COLUMN).value).toBe("OK");
  });

  it("writes NO_SERIAL with an empty warranty cell for a NOSN row", () => {
    const row = findRowBySerial(output, NOSN_SERIAL);

    expect(row.getCell(WARRANTY_STATUS_COLUMN).value).toBe("");
    expect(row.getCell(LOOKUP_STATUS_COLUMN).value).toBe("NO_SERIAL");
  });

  it("leaves rows with no result untouched", () => {
    let untouched = 0;
    output.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) {
        return;
      }
      const serial = String(row.getCell(10).value ?? "").trim().toUpperCase();
      if (resultsBySerial.has(serial)) {
        return;
      }
      expect(row.getCell(LOOKUP_STATUS_COLUMN).value ?? null).toBeNull();
      untouched += 1;
    });

    expect(untouched).toBeGreaterThan(0);
  });
});

function findRowBySerial(
  worksheet: ExcelJS.Worksheet,
  serial: string,
): ExcelJS.Row {
  let found: ExcelJS.Row | null = null;

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1 || found) {
      return;
    }
    const value = String(row.getCell(10).value ?? "")
      .trim()
      .toUpperCase();
    if (value === serial) {
      found = row;
    }
  });

  if (!found) {
    throw new Error(`Serial ${serial} not found in the output workbook`);
  }

  return found;
}
