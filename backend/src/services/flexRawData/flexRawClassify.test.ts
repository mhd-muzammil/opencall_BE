import { describe, expect, it } from "vitest";
import {
  classifyRawStatus,
  normalizeClosedOn,
  normalizeMonthKey,
} from "./flexRawClassify.js";

describe("classifyRawStatus", () => {
  it("keeps the four groups mutually exclusive, cancel before closed", () => {
    expect(classifyRawStatus("WO CLOSED IN CRM")).toBe("closed");
    expect(classifyRawStatus("CALL CANCELLED")).toBe("cancelled");
    expect(classifyRawStatus("WO CLOSED - CANCELLED")).toBe("cancelled");
    expect(classifyRawStatus("PENDING RESOLUTION")).toBe("resolved");
    expect(classifyRawStatus("OPEN")).toBe("open");
    expect(classifyRawStatus("")).toBe("open");
  });
});

describe("normalizeMonthKey", () => {
  it("reads the export's month spellings", () => {
    expect(normalizeMonthKey("Jul'25")).toBe("2025-07");
    expect(normalizeMonthKey("Jun-26")).toBe("2026-06");
    expect(normalizeMonthKey("July 2025")).toBe("2025-07");
    expect(normalizeMonthKey("Unknown")).toBe("");
  });
});

describe("normalizeClosedOn", () => {
  it("accepts an ISO day and truncates an ISO timestamp to one", () => {
    expect(normalizeClosedOn("2026-06-14")).toBe("2026-06-14");
    expect(normalizeClosedOn("2026-06-14T09:30:00.000Z")).toBe("2026-06-14");
    expect(normalizeClosedOn(" 2026-06-14 ")).toBe("2026-06-14");
  });

  it("rejects the junk the source column actually carries", () => {
    // ~20% of raw rows hold 'YES'/'NO'/blank where a date should be — those
    // must become null, never a fabricated date.
    expect(normalizeClosedOn("YES")).toBeNull();
    expect(normalizeClosedOn("NO")).toBeNull();
    expect(normalizeClosedOn("")).toBeNull();
    expect(normalizeClosedOn(null)).toBeNull();
    expect(normalizeClosedOn(undefined)).toBeNull();
    expect(normalizeClosedOn("45833.834965277776")).toBeNull();
    expect(normalizeClosedOn("14-06-2026")).toBeNull();
  });
});
