import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  extractSerials,
  isNoSerialValue,
  normalizeSerial,
  stripProductSuffix,
  type SerialExtractionResult,
} from "./serialExtractor.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("./__fixtures__/flex-wip-sample.xlsx", import.meta.url),
);

describe("stripProductSuffix", () => {
  it("strips the localization suffix, whatever it is", () => {
    expect(stripProductSuffix("4WF66A#ACJ")).toBe("4WF66A");
    expect(stripProductSuffix("1MR75A#460")).toBe("1MR75A");
    expect(stripProductSuffix("6QN28A#AB2")).toBe("6QN28A");
    expect(stripProductSuffix("2Z6L0PA#AKH")).toBe("2Z6L0PA");
  });

  it("passes through a product number that has no suffix", () => {
    expect(stripProductSuffix("A9T81B")).toBe("A9T81B");
  });

  it("returns null for blank input", () => {
    expect(stripProductSuffix(null)).toBeNull();
    expect(stripProductSuffix(undefined)).toBeNull();
    expect(stripProductSuffix("   ")).toBeNull();
    expect(stripProductSuffix("#ACJ")).toBeNull();
  });
});

describe("isNoSerialValue", () => {
  it("flags the NOSN junk placeholders", () => {
    expect(isNoSerialValue("A9T81B NOSN")).toBe(true);
    expect(isNoSerialValue("5HH67A NOSN")).toBe(true);
    expect(isNoSerialValue("28C12A NOSN")).toBe(true);
  });

  it("flags blanks", () => {
    expect(isNoSerialValue("")).toBe(true);
    expect(isNoSerialValue("   ")).toBe(true);
    expect(isNoSerialValue(null)).toBe(true);
  });

  it("does not flag a real serial", () => {
    expect(isNoSerialValue("TH49J5D1FB")).toBe(false);
    // "NOSN" only counts as its own token, not as a substring.
    expect(isNoSerialValue("NOSNX123")).toBe(false);
  });
});

describe("normalizeSerial", () => {
  it("trims, collapses whitespace and upper-cases", () => {
    expect(normalizeSerial("  th49j5d1fb ")).toBe("TH49J5D1FB");
    expect(normalizeSerial("A9T81B   NOSN")).toBe("A9T81B NOSN");
    expect(normalizeSerial(null)).toBe("");
  });
});

describe("extractSerials (real Flex WIP workbook)", () => {
  let extraction: SerialExtractionResult;

  beforeAll(async () => {
    extraction = await extractSerials(FIXTURE_PATH);
  });

  it("locates the sheet and the serial/product columns by header", () => {
    expect(extraction.sheetName).toBe("Report");
    expect(extraction.headerRow).toBe(1);
    // J and K in this export — found by header text, not by position.
    expect(extraction.serialColumn).toBe(10);
    expect(extraction.productColumn).toBe(11);
  });

  it("reads every data row", () => {
    expect(extraction.totalRows).toBe(519);
  });

  it("dedupes to unique serial candidates", () => {
    expect(extraction.candidates).toHaveLength(465);

    const serials = extraction.candidates.map((candidate) => candidate.serial);
    expect(new Set(serials).size).toBe(serials.length);
  });

  it("flags exactly the two NOSN junk serials, and nothing else", () => {
    const noSerial = extraction.candidates.filter(
      (candidate) => candidate.isNoSerial,
    );

    expect(noSerial).toHaveLength(2);
    expect(noSerial.map((candidate) => candidate.serial).sort()).toEqual([
      "28C12A NOSN",
      "A9T81B NOSN",
    ]);
  });

  it("leaves the rest queueable for HP", () => {
    const lookupable = extraction.candidates.filter(
      (candidate) => !candidate.isNoSerial,
    );
    expect(lookupable).toHaveLength(463);
  });

  it("carries the product number with the # suffix stripped", () => {
    const known = extraction.candidates.find(
      (candidate) => candidate.serial === "TH49J5D1FB",
    );

    expect(known).toBeDefined();
    // Column K holds `4WF66A#ACJ`.
    expect(known?.productNumber).toBe("4WF66A");
    expect(known?.isNoSerial).toBe(false);
  });

  it("never carries a # through to a product number", () => {
    const withSuffix = extraction.candidates.filter((candidate) =>
      candidate.productNumber?.includes("#"),
    );
    expect(withSuffix).toEqual([]);
  });
});
