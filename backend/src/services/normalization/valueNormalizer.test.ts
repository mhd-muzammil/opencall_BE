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
});
