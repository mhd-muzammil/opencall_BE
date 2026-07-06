import { describe, expect, it } from "vitest";

import { getSegment } from "./enrichmentHelpers.js";

describe("getSegment", () => {
  it("classifies Computing by WO OTC code", () => {
    expect(getSegment("Computing", "02N - Onsite Repair")).toBe("PC");
    expect(getSegment("Computing", "01 - Trade")).toBe("Trade PC");
    expect(getSegment("Computing", "05F - Comp Field Install")).toBe("Trade PC");
  });

  it("classifies Printing by WO OTC code", () => {
    expect(getSegment("Printing", "02N - Onsite Repair")).toBe("Print");
    expect(getSegment("Printing", "01 - Trade")).toBe("Trade Print");
    expect(getSegment("Printing", "05F - Comp Field Install")).toBe("Install");
  });

  it("treats dMPS like Printing", () => {
    expect(getSegment("dMPS", "02N - Onsite Repair")).toBe("Print");
    expect(getSegment("dMPS", "01 - Trade")).toBe("Trade Print");
    expect(getSegment("dMPS", "05F - Comp Field Install")).toBe("Install");
  });

  it("treats any TRADE-worded OTC code as trade", () => {
    expect(getSegment("Computing", "Trade")).toBe("Trade PC");
    expect(getSegment("Printing", "Trade")).toBe("Trade Print");
  });

  it("is tolerant of casing and spacing", () => {
    expect(getSegment("  computing ", " 05f - comp field install ")).toBe("Trade PC");
    expect(getSegment("PRINTING", "05F-COMP FIELD INSTALL")).toBe("Install");
  });

  it("returns blank for an unknown or missing business segment", () => {
    expect(getSegment(null, "02N")).toBe("");
    expect(getSegment("", "01 - Trade")).toBe("");
    expect(getSegment("Services", "02N")).toBe("");
  });
});
