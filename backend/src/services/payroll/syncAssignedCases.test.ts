import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isPayrollConfigured: vi.fn(),
  bulkDispatchCases: vi.fn(),
  getReportProductivity: vi.fn(),
  findLatestCompletedSessionByReportDate: vi.fn(),
  findProductivityRowsByReportId: vi.fn(),
  findEngineerContactByName: vi.fn(),
}));

vi.mock("./payrollClient.js", () => ({
  isPayrollConfigured: mocks.isPayrollConfigured,
  bulkDispatchCases: mocks.bulkDispatchCases,
}));

vi.mock("../productivity/eodService.js", () => ({
  getReportProductivity: mocks.getReportProductivity,
}));

vi.mock("../../repositories/historyRepository.js", () => ({
  findLatestCompletedSessionByReportDate: mocks.findLatestCompletedSessionByReportDate,
}));

vi.mock("../../repositories/dailyCallPlanReportRepository.js", () => ({
  findProductivityRowsByReportId: mocks.findProductivityRowsByReportId,
}));

vi.mock("../../repositories/engineerRepository.js", () => ({
  findEngineerContactByName: mocks.findEngineerContactByName,
}));

const { syncAssignedCasesForDate } = await import("./syncAssignedCases.js");

/** One engineer row shaped like the productivity view returns it. */
function engineer(
  name: string,
  assignedTickets: string[],
  closedTickets: string[] = [],
) {
  return {
    name,
    regionCode: "CHN",
    regionName: "Chennai",
    assigned: assignedTickets.length,
    assignedTickets,
    attended: closedTickets.length,
    attendedTickets: [...closedTickets],
    closed: closedTickets.length,
    closedTickets,
    partOrdered: 0,
    partOrderedTickets: [],
    underObservation: 0,
    underObservationTickets: [],
    cxReschedule: 0,
    cxRescheduleTickets: [],
    engineerDelay: 0,
    engineerDelayTickets: [],
  };
}

function productivity(list: ReturnType<typeof engineer>[]) {
  return { regions: [{ regionId: "r1", regionCode: "CHN", productivity: { list } }] };
}

type PushedCase = { external_ref: string; status?: string; address?: string };

function firstPush(): [PushedCase[], { mirror?: boolean } | undefined] {
  const call = mocks.bulkDispatchCases.mock.calls[0];
  if (!call) throw new Error("bulkDispatchCases was never called");
  return call as [PushedCase[], { mirror?: boolean } | undefined];
}

/** The cases[] array the sync would push, keyed by ticket. */
function pushedByRef() {
  const [cases] = firstPush();
  return new Map(cases.map((c) => [c.external_ref, c]));
}

describe("syncAssignedCasesForDate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isPayrollConfigured.mockReturnValue(true);
    mocks.bulkDispatchCases.mockResolvedValue({
      created: 0,
      updated: 0,
      assigned: 0,
      skipped: 0,
      total: 0,
      details: [],
    });
    mocks.findLatestCompletedSessionByReportDate.mockResolvedValue(null);
    mocks.findProductivityRowsByReportId.mockResolvedValue([]);
    mocks.findEngineerContactByName.mockResolvedValue(null);
  });

  it("does nothing when the integration is not configured", async () => {
    mocks.isPayrollConfigured.mockReturnValue(false);

    const result = await syncAssignedCasesForDate("2026-08-13");

    expect(result.configured).toBe(false);
    expect(mocks.bulkDispatchCases).not.toHaveBeenCalled();
  });

  it("pushes every assigned ticket for the engineer", async () => {
    mocks.getReportProductivity.mockResolvedValue(
      productivity([engineer("Praveen", ["WO-1", "WO-2", "WO-3"])]),
    );

    await syncAssignedCasesForDate("2026-08-13");

    const pushed = pushedByRef();
    expect([...pushed.keys()].sort()).toEqual(["WO-1", "WO-2", "WO-3"]);
    for (const ticket of pushed.values()) {
      expect(ticket.status).toBe("assigned");
    }
  });

  // The regression this file was added for.
  it("sends a closed ticket as completed, not assigned", async () => {
    // Assigned is the whole day's plan, so a closed call is in BOTH lists.
    mocks.getReportProductivity.mockResolvedValue(
      productivity([engineer("Praveen", ["WO-OPEN", "WO-DONE"], ["WO-DONE"])]),
    );

    await syncAssignedCasesForDate("2026-08-13");

    const pushed = pushedByRef();
    expect(pushed.get("WO-DONE")?.status).toBe("completed");
    expect(pushed.get("WO-OPEN")?.status).toBe("assigned");
  });

  it("still pushes the closed ticket, so Payroll can settle its own copy", async () => {
    mocks.getReportProductivity.mockResolvedValue(
      productivity([engineer("Praveen", ["WO-DONE"], ["WO-DONE"])]),
    );

    await syncAssignedCasesForDate("2026-08-13");

    // Dropping it instead would leave the engineer's Payroll case stuck as
    // assigned forever, and the mirror pass would cancel rather than complete it.
    expect(pushedByRef().has("WO-DONE")).toBe(true);
  });

  it("treats a ticket closed for one engineer as closed when another shares it", async () => {
    mocks.getReportProductivity.mockResolvedValue(
      productivity([
        engineer("Praveen", ["WO-SHARED"]),
        engineer("Samim", ["WO-SHARED"], ["WO-SHARED"]),
      ]),
    );

    await syncAssignedCasesForDate("2026-08-13");

    const [cases] = firstPush();
    // Both engineers' copies of the ticket report the same terminal outcome.
    const shared = cases.filter((c) => c.external_ref === "WO-SHARED");
    expect(shared).toHaveLength(2);
    expect(shared.every((c) => c.status === "completed")).toBe(true);
  });

  it("attaches the work location as the address when the day's rows have one", async () => {
    mocks.getReportProductivity.mockResolvedValue(
      productivity([engineer("Praveen", ["WO-1"])]),
    );
    mocks.findLatestCompletedSessionByReportDate.mockResolvedValue({
      daily_call_plan_report_id: "report-1",
    });
    mocks.findProductivityRowsByReportId.mockResolvedValue([
      { ticketId: "WO-1", workLocation: " Padi " },
    ]);

    await syncAssignedCasesForDate("2026-08-13");

    expect(pushedByRef().get("WO-1")?.address).toBe("Padi");
  });

  it("reports when the day has no assigned tickets instead of pushing an empty set", async () => {
    mocks.getReportProductivity.mockResolvedValue(productivity([engineer("Praveen", [])]));

    const result = await syncAssignedCasesForDate("2026-08-13");

    // An empty push would make Payroll's mirror pass cancel everything.
    expect(mocks.bulkDispatchCases).not.toHaveBeenCalled();
    expect(result.message).toMatch(/no assigned tickets/i);
  });

  it("leaves mirror to Payroll's default for the scheduled sync of today", async () => {
    mocks.getReportProductivity.mockResolvedValue(
      productivity([engineer("Praveen", ["WO-1"])]),
    );

    await syncAssignedCasesForDate("2026-08-13");

    // Today's plan IS authoritative, so the retract-what-is-absent behaviour
    // is wanted here and no flag is sent — Payroll's default (on) stands.
    expect(firstPush()[1]).toEqual({});
  });

  it("passes mirror:false through when the caller is not authoritative", async () => {
    mocks.getReportProductivity.mockResolvedValue(
      productivity([engineer("Praveen", ["WO-1"])]),
    );

    await syncAssignedCasesForDate("2026-08-01", { mirror: false });

    // A past date's plan must never retract the cases engineers are working now.
    expect(firstPush()[1]).toEqual({ mirror: false });
  });

  it("skips an engineer with a blank name rather than pushing an unassignable case", async () => {
    mocks.getReportProductivity.mockResolvedValue(
      productivity([engineer("   ", ["WO-ORPHAN"]), engineer("Praveen", ["WO-1"])]),
    );

    await syncAssignedCasesForDate("2026-08-13");

    const pushed = pushedByRef();
    expect(pushed.has("WO-ORPHAN")).toBe(false);
    expect(pushed.has("WO-1")).toBe(true);
  });
});
