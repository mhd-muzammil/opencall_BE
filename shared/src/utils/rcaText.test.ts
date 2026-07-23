import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  formatOrdinalDate,
  parseFlexibleDate,
} from "./dates.js";
import {
  buildAutoRca,
  buildScheduledRemark,
  isPartCaseText,
  pickWorkOrderShipmentStatus,
  resolveShipmentEta,
} from "./rcaText.js";
import { isScheduledStatus, SCHEDULED_STATUS } from "../constants/scheduling.js";

describe("parseFlexibleDate", () => {
  it("parses ISO year-first and Indian day-first, ignoring trailing time", () => {
    expect(parseFlexibleDate("2026-07-19")).toEqual({ year: 2026, month: 7, day: 19 });
    expect(parseFlexibleDate("19-07-2026 14:30")).toEqual({ year: 2026, month: 7, day: 19 });
    expect(parseFlexibleDate("19/07/2026")).toEqual({ year: 2026, month: 7, day: 19 });
  });

  it("returns null for junk / impossible dates", () => {
    expect(parseFlexibleDate("")).toBeNull();
    expect(parseFlexibleDate("not a date")).toBeNull();
    expect(parseFlexibleDate("2026-13-01")).toBeNull();
    expect(parseFlexibleDate(null)).toBeNull();
  });
});

describe("formatOrdinalDate", () => {
  it("applies the right ordinal suffix, incl. the 11-13 teens", () => {
    expect(formatOrdinalDate("2026-07-01")).toBe("1st July");
    expect(formatOrdinalDate("2026-07-02")).toBe("2nd July");
    expect(formatOrdinalDate("2026-07-03")).toBe("3rd July");
    expect(formatOrdinalDate("2026-07-04")).toBe("4th July");
    expect(formatOrdinalDate("2026-07-11")).toBe("11th July");
    expect(formatOrdinalDate("2026-07-12")).toBe("12th July");
    expect(formatOrdinalDate("2026-07-13")).toBe("13th July");
    expect(formatOrdinalDate("2026-07-21")).toBe("21st July");
    expect(formatOrdinalDate("2026-07-22")).toBe("22nd July");
    expect(formatOrdinalDate("2026-07-23")).toBe("23rd July");
    expect(formatOrdinalDate("2026-07-31")).toBe("31st July");
  });

  it("formats the Indian case_created_time shape", () => {
    expect(formatOrdinalDate("19-07-2026 09:15")).toBe("19th July");
  });

  it("returns empty string for unparseable input", () => {
    expect(formatOrdinalDate("garbage")).toBe("");
  });
});

describe("addCalendarDays", () => {
  it("adds one day within a month", () => {
    expect(addCalendarDays("2026-07-19", 1)).toBe("2026-07-20");
  });

  it("rolls over month and year boundaries", () => {
    expect(addCalendarDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
    // Leap-year February.
    expect(addCalendarDays("2028-02-28", 1)).toBe("2028-02-29");
    // From the Indian shape.
    expect(addCalendarDays("28-02-2027", 1)).toBe("2027-03-01");
  });

  it("returns empty string for unparseable input", () => {
    expect(addCalendarDays("nope", 1)).toBe("");
  });
});

describe("resolveShipmentEta", () => {
  const CREATED = "2026-07-19";

  it("maps each known status", () => {
    expect(resolveShipmentEta("Recommended", CREATED)).toBe("Part Recommended");
    expect(resolveShipmentEta("Backordered", CREATED)).toBe("Backordered");
    expect(resolveShipmentEta("Ordered", CREATED)).toBe("21st July"); // +2 days
    expect(resolveShipmentEta("Shipped", CREATED)).toBe("20th July"); // +1 day
    expect(resolveShipmentEta("Locked", CREATED)).toBe("20th July"); // +1 day
    expect(resolveShipmentEta("POD", CREATED)).toBe("19th July"); // same day
    expect(resolveShipmentEta("Closed", CREATED)).toBe("Closed");
  });

  it("Ordered: case received 16th -> ETA 18th (+2 calendar days)", () => {
    expect(resolveShipmentEta("Ordered", "2026-07-16")).toBe("18th July");
    expect(resolveShipmentEta(" ordered ", "2026-07-16")).toBe("18th July");
  });

  it("is case-insensitive and trims", () => {
    expect(resolveShipmentEta("  shipped ", CREATED)).toBe("20th July");
    expect(resolveShipmentEta("bAcKoRdErEd", CREATED)).toBe("Backordered");
  });

  it("echoes an unknown status verbatim (trimmed)", () => {
    expect(resolveShipmentEta("  Awaiting Vendor ", CREATED)).toBe("Awaiting Vendor");
  });
});

describe("pickWorkOrderShipmentStatus", () => {
  it("returns null when no part carries a status", () => {
    expect(pickWorkOrderShipmentStatus([])).toBeNull();
    expect(pickWorkOrderShipmentStatus([{ partShipmentStatus: "" }])).toBeNull();
    expect(pickWorkOrderShipmentStatus(null)).toBeNull();
  });

  it("picks the most-blocking status by precedence", () => {
    // Backordered outranks Recommended outranks Shipped.
    expect(
      pickWorkOrderShipmentStatus([
        { partShipmentStatus: "Shipped" },
        { partShipmentStatus: "Backordered" },
        { partShipmentStatus: "Recommended" },
      ]),
    ).toBe("Backordered");
    expect(
      pickWorkOrderShipmentStatus([
        { partShipmentStatus: "POD" },
        { partShipmentStatus: "Recommended" },
      ]),
    ).toBe("Recommended");
    // Ordered sits between Recommended and Locked/Shipped.
    expect(
      pickWorkOrderShipmentStatus([
        { partShipmentStatus: "Shipped" },
        { partShipmentStatus: "Ordered" },
      ]),
    ).toBe("Ordered");
    expect(
      pickWorkOrderShipmentStatus([
        { partShipmentStatus: "Ordered" },
        { partShipmentStatus: "Recommended" },
      ]),
    ).toBe("Recommended");
  });

  it("keeps original casing and lets a known status beat an unknown one", () => {
    expect(
      pickWorkOrderShipmentStatus([
        { partShipmentStatus: "Awaiting Vendor" },
        { partShipmentStatus: "shipped" },
      ]),
    ).toBe("shipped");
    // Only unknowns present -> first-seen unknown wins.
    expect(
      pickWorkOrderShipmentStatus([{ partShipmentStatus: "Awaiting Vendor" }]),
    ).toBe("Awaiting Vendor");
  });
});

describe("isPartCaseText", () => {
  it("treats a real part cell as a part case", () => {
    expect(isPartCaseText("Motherboard / Fuser")).toBe(true);
    expect(isPartCaseText("Motherboard  ⏳ 1 in transit")).toBe(true);
  });

  it("treats blank or 'Awaiting parts' as not a part case", () => {
    expect(isPartCaseText("")).toBe(false);
    expect(isPartCaseText(null)).toBe(false);
    expect(isPartCaseText("Awaiting parts")).toBe(false);
    expect(isPartCaseText("Awaiting parts  ⏳ 2 in transit")).toBe(false);
  });
});

describe("buildAutoRca — byte-exact templates (§3)", () => {
  const CREATED = "19-07-2026 09:00"; // 19th July
  const TODAY = "2026-07-20"; // 20th July

  it("active case, no engineer", () => {
    expect(
      buildAutoRca({
        caseCreatedTime: CREATED,
        isPartCase: false,
        partText: "",
        partShipmentStatus: null,
        engineer: "",
        todayIso: TODAY,
      }),
    ).toBe("Case Received on 19th July - active case");
  });

  it("active case, engineer assigned", () => {
    expect(
      buildAutoRca({
        caseCreatedTime: CREATED,
        isPartCase: false,
        partText: "",
        partShipmentStatus: null,
        engineer: "Praveen",
        todayIso: TODAY,
      }),
    ).toBe("Case Received on 19th July - active case - engineer scheduled 20th July");
  });

  it("active case ignores a placeholder engineer", () => {
    expect(
      buildAutoRca({
        caseCreatedTime: CREATED,
        isPartCase: false,
        partText: "",
        partShipmentStatus: null,
        engineer: "Manual Entry Required",
        todayIso: TODAY,
      }),
    ).toBe("Case Received on 19th July - active case");
  });

  it("part case for each shipment status", () => {
    const base = {
      caseCreatedTime: CREATED,
      isPartCase: true as const,
      partText: "Motherboard",
      engineer: "Praveen",
      todayIso: TODAY,
    };
    expect(buildAutoRca({ ...base, partShipmentStatus: "Recommended" })).toBe(
      "Case Received on 19th July - with part - (Motherboard) ETA: Part Recommended",
    );
    expect(buildAutoRca({ ...base, partShipmentStatus: "Backordered" })).toBe(
      "Case Received on 19th July - with part - (Motherboard) ETA: Backordered",
    );
    expect(buildAutoRca({ ...base, partShipmentStatus: "Shipped" })).toBe(
      "Case Received on 19th July - with part - (Motherboard) ETA: 20th July",
    );
    expect(buildAutoRca({ ...base, partShipmentStatus: "Locked" })).toBe(
      "Case Received on 19th July - with part - (Motherboard) ETA: 20th July",
    );
    expect(buildAutoRca({ ...base, partShipmentStatus: "POD" })).toBe(
      "Case Received on 19th July - with part - (Motherboard) ETA: 19th July",
    );
    expect(buildAutoRca({ ...base, partShipmentStatus: "Closed" })).toBe(
      "Case Received on 19th July - with part - (Motherboard) ETA: Closed",
    );
    expect(buildAutoRca({ ...base, partShipmentStatus: "Awaiting Vendor" })).toBe(
      "Case Received on 19th July - with part - (Motherboard) ETA: Awaiting Vendor",
    );
  });
});

describe("buildScheduledRemark", () => {
  it("renders the scheduled-on line", () => {
    expect(buildScheduledRemark("2026-07-20")).toBe("Scheduled on 20th July");
  });
});

describe("isScheduledStatus / SCHEDULED_STATUS", () => {
  it("matches case-insensitively and trims", () => {
    expect(SCHEDULED_STATUS).toBe("Scheduled");
    expect(isScheduledStatus("Scheduled")).toBe(true);
    expect(isScheduledStatus("  scheduled ")).toBe(true);
    expect(isScheduledStatus("To be Scheduled")).toBe(false);
    expect(isScheduledStatus("")).toBe(false);
    expect(isScheduledStatus(null)).toBe(false);
  });
});
