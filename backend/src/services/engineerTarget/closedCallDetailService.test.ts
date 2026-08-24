import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The drill-down promises that a call can never be counted without appearing in the
 * list that explains the count. These are the two ways that promise was broken in
 * production, both silent: the row was there, it just could not find its own engineer.
 */

const mocks = vi.hoisted(() => ({
  findReportDaysInRange: vi.fn(),
  findProductivityRowsByReportId: vi.fn(),
  findClosedCallDetailsByReportId: vi.fn(),
}));

vi.mock("../../repositories/engineerTargetRepository.js", () => ({
  findReportDaysInRange: mocks.findReportDaysInRange,
}));

vi.mock("../../repositories/dailyCallPlanReportRepository.js", () => ({
  findProductivityRowsByReportId: mocks.findProductivityRowsByReportId,
}));

vi.mock("../../repositories/closedCallDetailRepository.js", () => ({
  findClosedCallDetailsByReportId: mocks.findClosedCallDetailsByReportId,
}));

const { getClosedCallDetails } = await import("./closedCallDetailService.js");

/** A persisted row shaped the way findProductivityRowsByReportId returns them. */
function persistedRow(over: {
  serialNo: number;
  ticketId: string;
  engineer: string;
  workLocation?: string;
}) {
  return {
    serialNo: over.serialNo,
    ticketId: over.ticketId,
    engineer: over.engineer,
    // A same-day close: booked in the plan (the gate the calculation applies first),
    // then closed on the report day.
    rtplStatus: "Scheduled",
    eveningRtplStatus: "",
    workLocation: over.workLocation ?? "ASPS01463",
    flexStatus: "",
    closedSyntheticRow: false,
    sameDayClosedRow: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findReportDaysInRange.mockResolvedValue([
    { reportId: "r1", reportDate: "2026-08-24" },
  ]);
});

describe("getClosedCallDetails", () => {
  it("names an aliased engineer as the counts do, not as the report row spells them", async () => {
    // "Lava Kumar" is an alias of "Lava" in the shared calculation, so the board and
    // every engineer view call this person "Lava". The report row still says
    // "Lava Kumar", and a caller grouping on that raw text loses the call entirely.
    mocks.findProductivityRowsByReportId.mockResolvedValue([
      persistedRow({ serialNo: 1, ticketId: "TK-100", engineer: "Lava Kumar" }),
    ]);
    mocks.findClosedCallDetailsByReportId.mockResolvedValue([
      {
        serialNo: 1,
        ticketId: "TK-100",
        caseId: "C-1",
        engineer: "Lava Kumar",
        segment: "PC",
        productName: "Laptop",
        workLocation: "ASPS01463",
        woOtcCode: "W1",
      },
    ]);

    const res = await getClosedCallDetails({
      fromDate: "2026-08-24",
      toDate: "2026-08-24",
      allowedAspCodes: null,
    });

    expect(res.calls).toHaveLength(1);
    expect(res.calls[0]?.engineerName).toBe("Lava");
    // The raw text is still carried, just no longer the only name on offer.
    expect(res.calls[0]?.engineer).toBe("Lava Kumar");
  });

  it("includes a closed call whose Ticket ID column is blank", async () => {
    // With no ticket the calculation identifies the row by its serial number, so a
    // lookup that only matches ticket_id drops the call: counted, but unexplainable.
    mocks.findProductivityRowsByReportId.mockResolvedValue([
      persistedRow({ serialNo: 42, ticketId: "", engineer: "Vijayakumar Arakonam" }),
    ]);
    mocks.findClosedCallDetailsByReportId.mockResolvedValue([
      {
        serialNo: 42,
        ticketId: "",
        caseId: "C-2",
        engineer: "Vijayakumar Arakonam",
        segment: "Print",
        productName: "Printer",
        workLocation: "ASPS01463",
        woOtcCode: "W2",
      },
    ]);

    const res = await getClosedCallDetails({
      fromDate: "2026-08-24",
      toDate: "2026-08-24",
      allowedAspCodes: null,
    });

    // The serial number is what the calculation asked for, so it is what the lookup
    // must be given.
    expect(mocks.findClosedCallDetailsByReportId).toHaveBeenCalledWith("r1", ["42"]);
    expect(res.calls).toHaveLength(1);
    expect(res.calls[0]?.engineerName).toBe("Vijayakumar Arakonam");
    // Region resolution has to survive the same fallback, or the cell is blank anyway.
    expect(res.calls[0]?.workLocationName).toBe("VELLORE");
  });

  it("counts and lists the same calls", async () => {
    mocks.findProductivityRowsByReportId.mockResolvedValue([
      persistedRow({ serialNo: 1, ticketId: "TK-1", engineer: "Santhosh" }),
      persistedRow({ serialNo: 2, ticketId: "", engineer: "Santhosh" }),
    ]);
    mocks.findClosedCallDetailsByReportId.mockResolvedValue([
      {
        serialNo: 1, ticketId: "TK-1", caseId: "", engineer: "Santhosh",
        segment: "PC", productName: "", workLocation: "ASPS01463", woOtcCode: "",
      },
      {
        serialNo: 2, ticketId: "", caseId: "", engineer: "Santhosh",
        segment: "PC", productName: "", workLocation: "ASPS01463", woOtcCode: "",
      },
    ]);

    const res = await getClosedCallDetails({
      fromDate: "2026-08-24",
      toDate: "2026-08-24",
      allowedAspCodes: null,
    });

    expect(res.totalClosed).toBe(2);
    expect(res.calls.every((c) => c.engineerName === "Santhosh")).toBe(true);
  });
});
