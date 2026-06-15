import { describe, expect, it } from "vitest";
import { computeFlexStatusUnchangedDaysFromHistory } from "./flexStatusUnchangedDays.js";

describe("computeFlexStatusUnchangedDaysFromHistory", () => {
  it("returns null when there is no previous report at all", () => {
    expect(
      computeFlexStatusUnchangedDaysFromHistory({
        currentFlexStatus: "Open",
        reportDate: "2026-06-13",
        previousReports: [],
        hadPreviousReport: false,
      }),
    ).toBeNull();
  });

  it("returns 0 for a brand-new ticket (absent from the most recent prior report)", () => {
    expect(
      computeFlexStatusUnchangedDaysFromHistory({
        currentFlexStatus: "Open",
        reportDate: "2026-06-13",
        previousReports: [{ reportDate: "2026-06-12", flexStatus: undefined }],
        hadPreviousReport: true,
      }),
    ).toBe(0);
  });

  it("returns 0 when the status changed today", () => {
    expect(
      computeFlexStatusUnchangedDaysFromHistory({
        currentFlexStatus: "Closed",
        reportDate: "2026-06-13",
        previousReports: [{ reportDate: "2026-06-12", flexStatus: "Open" }],
        hadPreviousReport: true,
      }),
    ).toBe(0);
  });

  it("counts one calendar day when unchanged since yesterday's report", () => {
    expect(
      computeFlexStatusUnchangedDaysFromHistory({
        currentFlexStatus: "Open",
        reportDate: "2026-06-13",
        previousReports: [{ reportDate: "2026-06-12", flexStatus: "Open" }],
        hadPreviousReport: true,
      }),
    ).toBe(1);
  });

  it("counts real calendar days, bridging gaps between non-daily reports", () => {
    // Unchanged since the 2026-06-03 report => 10 calendar days to 2026-06-13,
    // even though only 3 reports happened in between.
    expect(
      computeFlexStatusUnchangedDaysFromHistory({
        currentFlexStatus: "Open",
        reportDate: "2026-06-13",
        previousReports: [
          { reportDate: "2026-06-12", flexStatus: "Open" },
          { reportDate: "2026-06-11", flexStatus: "Open" },
          { reportDate: "2026-06-03", flexStatus: "Open" },
          { reportDate: "2026-06-02", flexStatus: "Closed" },
        ],
        hadPreviousReport: true,
      }),
    ).toBe(10);
  });

  it("stops the run at the first day the status differed", () => {
    // Matches 06-12 only; 06-11 differs => unchanged for 1 day.
    expect(
      computeFlexStatusUnchangedDaysFromHistory({
        currentFlexStatus: "Open",
        reportDate: "2026-06-13",
        previousReports: [
          { reportDate: "2026-06-12", flexStatus: "Open" },
          { reportDate: "2026-06-11", flexStatus: "Closed" },
          { reportDate: "2026-06-03", flexStatus: "Open" },
        ],
        hadPreviousReport: true,
      }),
    ).toBe(1);
  });

  it("stops the run at a gap where the ticket was absent", () => {
    expect(
      computeFlexStatusUnchangedDaysFromHistory({
        currentFlexStatus: "Open",
        reportDate: "2026-06-13",
        previousReports: [
          { reportDate: "2026-06-12", flexStatus: "Open" },
          { reportDate: "2026-06-11", flexStatus: undefined },
          { reportDate: "2026-06-03", flexStatus: "Open" },
        ],
        hadPreviousReport: true,
      }),
    ).toBe(1);
  });

  it("ignores case and surrounding whitespace when comparing statuses", () => {
    expect(
      computeFlexStatusUnchangedDaysFromHistory({
        currentFlexStatus: "  open ",
        reportDate: "2026-06-13",
        previousReports: [
          { reportDate: "2026-06-12", flexStatus: "OPEN" },
          { reportDate: "2026-06-11", flexStatus: "open" },
        ],
        hadPreviousReport: true,
      }),
    ).toBe(2);
  });

  it("treats blank-to-value as a status change (0 days)", () => {
    expect(
      computeFlexStatusUnchangedDaysFromHistory({
        currentFlexStatus: "Open",
        reportDate: "2026-06-13",
        previousReports: [{ reportDate: "2026-06-12", flexStatus: null }],
        hadPreviousReport: true,
      }),
    ).toBe(0);
  });

  it("counts a ticket that stays blank across consecutive days", () => {
    expect(
      computeFlexStatusUnchangedDaysFromHistory({
        currentFlexStatus: null,
        reportDate: "2026-06-13",
        previousReports: [
          { reportDate: "2026-06-12", flexStatus: null },
          { reportDate: "2026-06-11", flexStatus: "   " },
        ],
        hadPreviousReport: true,
      }),
    ).toBe(2);
  });
});
