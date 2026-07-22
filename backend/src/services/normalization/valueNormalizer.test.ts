import { describe, expect, it } from "vitest";
import { parseExcelDate } from "./valueNormalizer.js";

describe("parseExcelDate", () => {
  it("parses Flex WIP day-first create-time values", () => {
    const parsed = parseExcelDate("28-04-2026 01:34:30 PM");

    expect(parsed).not.toBeNull();
    expect(parsed?.toISOString()).toBe("2026-04-28T08:04:30.000Z");
  });

  it("treats Excel Date cells as IST wall-clock values", () => {
    const parsed = parseExcelDate(new Date(2026, 4, 13, 10, 25, 4));

    expect(parsed).not.toBeNull();
    expect(parsed?.toISOString()).toBe("2026-05-13T04:55:04.000Z");
  });

  // Regression (prod 2026-07-21): the FieldEZ export shipped "Create Time" as
  // unformatted cells, so every value arrived as a bare Excel serial float and
  // parsed to null — blanking the WIP aging column for that day's upload.
  it("parses unformatted Excel serial date cells as IST wall-clock values", () => {
    const parsed = parseExcelDate(46191.559415868054);

    expect(parsed).not.toBeNull();
    expect(parsed?.toISOString()).toBe("2026-06-18T07:55:34.000Z");
  });

  it("parses an Excel serial that arrived pre-stringified", () => {
    expect(parseExcelDate("46191.559415868054")?.toISOString()).toBe(
      "2026-06-18T07:55:34.000Z",
    );
  });

  it("rejects numbers outside the plausible serial-date range", () => {
    // A stray count, id or aging value must never be read as a timestamp.
    expect(parseExcelDate(0)).toBeNull();
    expect(parseExcelDate(42)).toBeNull();
    expect(parseExcelDate(999_999)).toBeNull();
    expect(parseExcelDate(Number.NaN)).toBeNull();
  });

  it("still rejects blank and non-date text", () => {
    expect(parseExcelDate("")).toBeNull();
    expect(parseExcelDate("not-a-date")).toBeNull();
  });
});
