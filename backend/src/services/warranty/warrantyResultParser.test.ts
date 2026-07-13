import { describe, expect, it } from "vitest";
import { parseHpDate, parseWarrantyResult } from "./warrantyResultParser.js";

/** How HP renders the block on a resolved `/warrantyresult/` page. */
const ADDITIONAL_INFORMATION_BLOCK = `
Additional Information
Product number
4WF66A
Serial number
TH49J5D1FB
Start date
January 6, 2023
End date
January 5, 2026
Status
Active
Service level
Next business day onsite
`;

const DD_MON_YYYY_BLOCK = `
Additional Information
Serial number
5CD1234ABC
Start date
06-Jan-2023
End date
05-Jan-2026
Status
Expired
`;

const INLINE_LABEL_BLOCK = `
Additional Information
End date: 05/01/2026
Status: Active
`;

/** A resolved page for a unit HP knows about but has no entitlement for. */
const NO_ENTITLEMENT_BLOCK = `
Additional Information
Product number
4WF66A
Serial number
TH49J5D1FB
Status
No warranty found
`;

describe("parseHpDate", () => {
  it("parses the formats HP renders", () => {
    expect(parseHpDate("January 5, 2026")).toBe("2026-01-05");
    expect(parseHpDate("Jan 5, 2026")).toBe("2026-01-05");
    expect(parseHpDate("05-Jan-2026")).toBe("2026-01-05");
    expect(parseHpDate("5 January 2026")).toBe("2026-01-05");
    // Day-first: the entry point is the in-en site.
    expect(parseHpDate("05/01/2026")).toBe("2026-01-05");
    expect(parseHpDate("2026-01-05")).toBe("2026-01-05");
  });

  it("rejects junk and impossible dates", () => {
    expect(parseHpDate(null)).toBeNull();
    expect(parseHpDate("")).toBeNull();
    expect(parseHpDate("Not available")).toBeNull();
    expect(parseHpDate("31-Feb-2026")).toBeNull();
    expect(parseHpDate("Smarch 5, 2026")).toBeNull();
  });
});

describe("parseWarrantyResult", () => {
  it("reads End date and Status by label", () => {
    expect(parseWarrantyResult(ADDITIONAL_INFORMATION_BLOCK)).toEqual({
      lookupStatus: "OK",
      endDate: "2026-01-05",
      hpStatus: "Active",
    });
  });

  it("handles the DD-Mon-YYYY variant", () => {
    expect(parseWarrantyResult(DD_MON_YYYY_BLOCK)).toEqual({
      lookupStatus: "OK",
      endDate: "2026-01-05",
      hpStatus: "Expired",
    });
  });

  it("handles labels and values on the same line", () => {
    expect(parseWarrantyResult(INLINE_LABEL_BLOCK)).toEqual({
      lookupStatus: "OK",
      endDate: "2026-01-05",
      hpStatus: "Active",
    });
  });

  it("returns NOT_FOUND when a resolved page carries no end date", () => {
    expect(parseWarrantyResult(NO_ENTITLEMENT_BLOCK)).toEqual({
      lookupStatus: "NOT_FOUND",
      endDate: null,
      hpStatus: "No warranty found",
    });
  });

  it("returns NOT_FOUND for an empty page", () => {
    expect(parseWarrantyResult("")).toEqual({
      lookupStatus: "NOT_FOUND",
      endDate: null,
      hpStatus: null,
    });
  });

  it("does not mistake a look-alike label for Status", () => {
    const block = `
Additional Information
Status Remarks
Part pending
End date
January 5, 2026
Status
Active
`;

    expect(parseWarrantyResult(block).hpStatus).toBe("Active");
  });
});
