import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyProductivityStatus,
  type EngineerProductivityResult,
} from "@opencall/shared";
import type { AuthenticatedUser } from "../../types/auth.js";

const mocks = vi.hoisted(() => {
  interface StoredState {
    id: string;
    regionId: string;
    workingDate: string;
    status: "OPEN" | "CLOSED";
    closedAt: string | null;
    closedBy: string | null;
    closedByDisplay: string | null;
  }

  const eodStates = new Map<string, StoredState>();
  const snapshots = new Map<string, EngineerProductivityResult>();
  const key = (regionId: string, workingDate: string) =>
    `${regionId}:${workingDate}`;

  return {
    eodStates,
    snapshots,
    key,
    generateDailyCallPlanReport: vi.fn(),
    findProductivityRowsByReportId: vi.fn(),
    findLatestCompletedSessionByReportDate: vi.fn(),
    findAllowedRegionsForUser: vi.fn(),
    findRegionById: vi.fn(),
    listRegions: vi.fn(),
  };
});

vi.mock("../../config/database.js", () => ({
  // The service only passes the client through to the (mocked) repository.
  withTransaction: (fn: (client: unknown) => Promise<unknown>) => fn({}),
}));

// The EOD service must be READ-ONLY over the day's report: it reads persisted
// rows and must NEVER call the generator (regenerating from a region-scoped
// batch mass-closes other regions — the 2026-07-23 incident).
vi.mock("../callPlanGenerator/dailyCallPlanGenerator.js", () => ({
  generateDailyCallPlanReport: mocks.generateDailyCallPlanReport,
}));

vi.mock("../../repositories/dailyCallPlanReportRepository.js", () => ({
  findProductivityRowsByReportId: mocks.findProductivityRowsByReportId,
}));

vi.mock("../../repositories/historyRepository.js", () => ({
  findLatestCompletedSessionByReportDate:
    mocks.findLatestCompletedSessionByReportDate,
}));

vi.mock("../rbac/regionAccessService.js", () => ({
  findAllowedRegionsForUser: mocks.findAllowedRegionsForUser,
}));

vi.mock("../../repositories/regionRepository.js", () => ({
  findRegionById: mocks.findRegionById,
  listRegions: mocks.listRegions,
}));

vi.mock("../../repositories/regionEodRepository.js", () => ({
  findEodStatesForDate: async (workingDate: string) =>
    [...mocks.eodStates.values()].filter((s) => s.workingDate === workingDate),
  findEodStateForUpdate: async (
    _client: unknown,
    regionId: string,
    workingDate: string,
  ) => mocks.eodStates.get(mocks.key(regionId, workingDate)) ?? null,
  markRegionEodClosed: async (
    _client: unknown,
    regionId: string,
    workingDate: string,
    closedBy: string,
  ) => {
    const state = {
      id: `state-${mocks.key(regionId, workingDate)}`,
      regionId,
      workingDate,
      status: "CLOSED" as const,
      closedAt: "2026-07-17T14:30:00Z",
      closedBy,
      closedByDisplay: null,
    };
    mocks.eodStates.set(mocks.key(regionId, workingDate), state);
    return state;
  },
  markRegionEodOpen: async (
    _client: unknown,
    regionId: string,
    workingDate: string,
  ) => {
    const existing = mocks.eodStates.get(mocks.key(regionId, workingDate));
    if (!existing) return null;
    const state = {
      ...existing,
      status: "OPEN" as const,
      closedAt: null,
      closedBy: null,
    };
    mocks.eodStates.set(mocks.key(regionId, workingDate), state);
    return state;
  },
  upsertProductivitySnapshot: async (
    _client: unknown,
    regionId: string,
    workingDate: string,
    payload: EngineerProductivityResult,
  ) => {
    mocks.snapshots.set(mocks.key(regionId, workingDate), payload);
  },
  deleteProductivitySnapshot: async (
    _client: unknown,
    regionId: string,
    workingDate: string,
  ) => {
    mocks.snapshots.delete(mocks.key(regionId, workingDate));
  },
  findSnapshot: async (
    _client: unknown,
    regionId: string,
    workingDate: string,
  ) => {
    const payload = mocks.snapshots.get(mocks.key(regionId, workingDate));
    return payload
      ? { regionId, workingDate, payload, createdAt: "2026-07-17T14:30:00Z" }
      : null;
  },
  findSnapshotsForDate: async (workingDate: string) =>
    [...mocks.snapshots.entries()]
      .filter(([k]) => k.endsWith(`:${workingDate}`))
      .map(([k, payload]) => ({
        regionId: k.split(":")[0] ?? "",
        workingDate,
        payload,
        createdAt: "2026-07-17T14:30:00Z",
      })),
}));

import {
  closeRegionEod,
  getRegionEodState,
  getReportProductivity,
  getReportProductivityRange,
  reopenRegionEod,
} from "./eodService.js";

const WORKING_DATE = "2026-07-17";

const chennai = {
  id: "0b7f6f3a-0000-4000-8000-000000000001",
  code: "ASPS01461",
  name: "Chennai",
  isActive: true,
  createdAt: "",
};
const vellore = {
  id: "0b7f6f3a-0000-4000-8000-000000000002",
  code: "ASPS01463",
  name: "Vellore",
  isActive: true,
  createdAt: "",
};

const superAdmin: AuthenticatedUser = {
  id: "8f5b0000-0000-4000-8000-00000000000a",
  email: "admin@opencall.test",
  username: "admin",
  role: "SUPER_ADMIN",
  regionId: null,
  region_id: null,
  mustChangePassword: false,
  accessibleSections: null,
};

const chennaiAdmin: AuthenticatedUser = {
  ...superAdmin,
  id: "8f5b0000-0000-4000-8000-00000000000b",
  email: "chennai@opencall.test",
  role: "REGION_ADMIN",
  regionId: chennai.id,
  region_id: chennai.id,
};

/** Persisted-row shapes as findProductivityRowsByReportId returns them. */
function persistedRows(
  rows: Array<{
    ticketId: string;
    engineer: string;
    morning?: string;
    evening?: string;
    workLocation?: string;
    sameDayClosed?: boolean;
  }>,
) {
  return rows.map((row, index) => ({
    serialNo: index + 1,
    ticketId: row.ticketId,
    engineer: row.engineer,
    rtplStatus: row.morning ?? "",
    eveningRtplStatus: row.evening ?? "",
    workLocation: row.workLocation ?? chennai.code,
    flexStatus: "Open",
    closedSyntheticRow: row.sameDayClosed ?? false,
    sameDayClosedRow: row.sameDayClosed ?? false,
  }));
}

beforeEach(() => {
  mocks.eodStates.clear();
  mocks.snapshots.clear();
  vi.clearAllMocks();

  mocks.findRegionById.mockImplementation(async (id: string) =>
    [chennai, vellore].find((r) => r.id === id) ?? null,
  );
  mocks.listRegions.mockResolvedValue([chennai, vellore]);
  mocks.findLatestCompletedSessionByReportDate.mockResolvedValue({
    id: "session-1",
    daily_call_plan_report_id: "report-1",
    flex_upload_batch_id: "6f5b0000-0000-4000-8000-000000000001",
    renderways_upload_batch_id: null,
    call_plan_upload_batch_id: null,
  });
  mocks.findAllowedRegionsForUser.mockImplementation(
    async (user: AuthenticatedUser) =>
      user.role === "SUPER_ADMIN" ? null : [chennai],
  );
  mocks.findProductivityRowsByReportId.mockResolvedValue(
    persistedRows([
      { ticketId: "W1", engineer: "Ravi", morning: "Scheduled" },
      { ticketId: "W2", engineer: "Ravi", morning: "Scheduled", evening: "Case-Closed" },
      { ticketId: "V1", engineer: "Vel", morning: "Scheduled", workLocation: vellore.code },
    ]),
  );
});

describe("closeRegionEod", () => {
  it("freezes the region's day-scoped productivity into a snapshot", async () => {
    const result = await closeRegionEod(superAdmin, chennai.id, WORKING_DATE);

    expect(result.frozenNow).toBe(true);
    expect(result.state.status).toBe("CLOSED");
    // Only Chennai rows count: Ravi assigned 2 (1 scheduled + 1 closed today).
    expect(result.snapshot.list).toHaveLength(1);
    expect(result.snapshot.list[0]?.name).toBe("Ravi");
    expect(result.snapshot.list[0]?.assigned).toBe(2);
    expect(result.snapshot.list[0]?.closed).toBe(1);
    expect(result.snapshot.totalAttended).toBe(1);
  });

  it("later edits do not change the closed day's numbers", async () => {
    const first = await closeRegionEod(superAdmin, chennai.id, WORKING_DATE);
    expect(first.snapshot.totalAttended).toBe(1);

    // The day's report changes after the close (an evening edit, a new call).
    mocks.findProductivityRowsByReportId.mockResolvedValue(
      persistedRows([
        { ticketId: "W1", engineer: "Ravi", morning: "Scheduled", evening: "Case-Closed" },
        { ticketId: "W2", engineer: "Ravi", morning: "Scheduled", evening: "Case-Closed" },
        { ticketId: "W9", engineer: "Ravi", morning: "Scheduled", evening: "Case-Closed" },
      ]),
    );

    // A repeat close is an idempotent no-op: the first freeze stands.
    const second = await closeRegionEod(superAdmin, chennai.id, WORKING_DATE);
    expect(second.frozenNow).toBe(false);
    expect(second.snapshot).toEqual(first.snapshot);

    // The productivity read serves the frozen snapshot, not the edited rows.
    const read = await getReportProductivity(WORKING_DATE);
    const chennaiEntry = read.regions.find((r) => r.regionId === chennai.id);
    expect(chennaiEntry?.source).toBe("FROZEN");
    expect(chennaiEntry?.productivity).toEqual(first.snapshot);
  });

  it("keeps other regions live and independent after one region closes", async () => {
    await closeRegionEod(superAdmin, chennai.id, WORKING_DATE);

    const read = await getReportProductivity(WORKING_DATE);
    const velloreEntry = read.regions.find((r) => r.regionId === vellore.id);
    expect(velloreEntry?.source).toBe("LIVE");
    expect(velloreEntry?.productivity.list[0]?.name).toBe("Vel");
  });

  it("allows a REGION_ADMIN to close their own region", async () => {
    const result = await closeRegionEod(chennaiAdmin, chennai.id, WORKING_DATE);
    expect(result.state.status).toBe("CLOSED");
    expect(result.state.closedBy).toBe(chennaiAdmin.id);
  });

  it("rejects a REGION_ADMIN closing another region (403)", async () => {
    await expect(
      closeRegionEod(chennaiAdmin, vellore.id, WORKING_DATE),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.eodStates.size).toBe(0);
  });

  it("rejects a close when no completed report exists for the date", async () => {
    mocks.findLatestCompletedSessionByReportDate.mockResolvedValue(null);
    await expect(
      closeRegionEod(superAdmin, chennai.id, WORKING_DATE),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  // Regression for the 2026-07-23 mass-close: closing a region regenerated the
  // whole day's report from the newest session's Flex batch; when that batch
  // was region-scoped (one region's file), every other region's open call was
  // treated as vanished-from-Flex and persisted as same-day CLOSED. The close
  // and the productivity read must be strictly read-only over the report.
  it("never regenerates the day's report — close and reads are read-only", async () => {
    await closeRegionEod(superAdmin, chennai.id, WORKING_DATE);
    await getReportProductivity(WORKING_DATE);

    expect(mocks.generateDailyCallPlanReport).not.toHaveBeenCalled();
    expect(mocks.findProductivityRowsByReportId).toHaveBeenCalledWith("report-1");
  });
});

describe("reopenRegionEod", () => {
  it("is SUPER_ADMIN only (403 for a region admin, even for their own region)", async () => {
    await closeRegionEod(superAdmin, chennai.id, WORKING_DATE);
    await expect(
      reopenRegionEod(chennaiAdmin, chennai.id, WORKING_DATE),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("reopen restores live compute (snapshot deleted, region OPEN)", async () => {
    await closeRegionEod(superAdmin, chennai.id, WORKING_DATE);

    const result = await reopenRegionEod(superAdmin, chennai.id, WORKING_DATE);
    expect(result.reopened).toBe(true);
    expect(result.state?.status).toBe("OPEN");

    const read = await getReportProductivity(WORKING_DATE);
    const chennaiEntry = read.regions.find((r) => r.regionId === chennai.id);
    expect(chennaiEntry?.source).toBe("LIVE");

    const state = await getRegionEodState(WORKING_DATE);
    expect(
      state.regions.find((r) => r.regionId === chennai.id)?.status,
    ).toBe("OPEN");
  });

  it("is an idempotent no-op when the region-day was never closed", async () => {
    const result = await reopenRegionEod(superAdmin, chennai.id, WORKING_DATE);
    expect(result.reopened).toBe(false);
  });
});

// The shared classifier feeds the frozen snapshots, so its mapping is part of
// the backend contract too — not just the frontend live view.
describe("classifyProductivityStatus (shared classifier)", () => {
  it("maps the bare 'Elevation' status (any casing) to UNDER_OBSERVATION", () => {
    expect(classifyProductivityStatus("elevation")).toBe("UNDER_OBSERVATION");
    expect(classifyProductivityStatus("Elevation")).toBe("UNDER_OBSERVATION");
    expect(classifyProductivityStatus("ELEVATION")).toBe("UNDER_OBSERVATION");
    expect(classifyProductivityStatus("under observation")).toBe(
      "UNDER_OBSERVATION",
    );
  });

  // Reversed 2026-07-31: the longer "Elevation ..." statuses used to fall
  // through to ATTENDED_OTHER, so an elevated call was Attended but appeared in
  // no named column. The whole family now shares the bucket the column is
  // already named after ("Under Observation/Elevation").
  it("maps every 'Elevation ...' status to UNDER_OBSERVATION", () => {
    expect(classifyProductivityStatus("Elevation HP Pending")).toBe(
      "UNDER_OBSERVATION",
    );
    expect(classifyProductivityStatus("Elevation Part Pending")).toBe(
      "UNDER_OBSERVATION",
    );
    expect(classifyProductivityStatus("HP Pending")).toBe("UNDER_OBSERVATION");
  });

  it("freezes an Elevation evening into the underObservation snapshot column", async () => {
    mocks.findProductivityRowsByReportId.mockResolvedValue(
      persistedRows([
        { ticketId: "E1", engineer: "Ravi", morning: "Scheduled", evening: "Elevation" },
        { ticketId: "E2", engineer: "Ravi", morning: "Scheduled", evening: "Elevation HP Pending" },
      ]),
    );

    const result = await closeRegionEod(superAdmin, chennai.id, WORKING_DATE);
    // The snapshot payload keys stay the stable camelCase fields — stored
    // frozen snapshots must keep deserializing unchanged.
    expect(result.snapshot.list[0]?.underObservation).toBe(2);
    expect(result.snapshot.list[0]?.underObservationTickets).toEqual(["E1", "E2"]);
    // Both are attended work, and both now land in the named column.
    expect(result.snapshot.list[0]?.attended).toBe(2);
  });
});

describe("getRegionEodState", () => {
  it("reports OPEN/CLOSED per region with the frozen snapshot attached", async () => {
    const closed = await closeRegionEod(superAdmin, chennai.id, WORKING_DATE);

    const state = await getRegionEodState(WORKING_DATE);
    expect(state.workingDate).toBe(WORKING_DATE);
    expect(state.regions).toHaveLength(2);

    const chennaiEntry = state.regions.find((r) => r.regionId === chennai.id);
    expect(chennaiEntry?.status).toBe("CLOSED");
    expect(chennaiEntry?.closedAt).toBe("2026-07-17T14:30:00Z");
    expect(chennaiEntry?.snapshot).toEqual(closed.snapshot);

    const velloreEntry = state.regions.find((r) => r.regionId === vellore.id);
    expect(velloreEntry?.status).toBe("OPEN");
    expect(velloreEntry?.snapshot).toBeNull();
  });
});

describe("getReportProductivityRange", () => {
  /**
   * The date-range filter used to filter ONE report's rows by Case Created Time,
   * so a month-long range showed a single day's work. A range is the days added
   * up — these tests pin that, and pin that it stays the same days the day-by-day
   * view shows.
   */
  it("sums each day in the range instead of reading one day", async () => {
    // Three consecutive days, each with the same two Chennai rows for Ravi.
    const range = await getReportProductivityRange("2026-07-15", "2026-07-17");

    expect(range.from).toBe("2026-07-15");
    expect(range.to).toBe("2026-07-17");
    expect(range.days).toEqual(["2026-07-15", "2026-07-16", "2026-07-17"]);
    expect(range.missingDays).toEqual([]);

    const chennaiEntry = range.regions.find((r) => r.regionId === chennai.id);
    // One day is assigned 2 / closed 1; three days is three times that.
    expect(chennaiEntry?.productivity.list).toHaveLength(1);
    expect(chennaiEntry?.productivity.list[0]?.name).toBe("Ravi");
    expect(chennaiEntry?.productivity.list[0]?.assigned).toBe(6);
    expect(chennaiEntry?.productivity.list[0]?.closed).toBe(3);
    expect(chennaiEntry?.productivity.totalAttended).toBe(3);
  });

  it("equals the single-day read when the range is one day", async () => {
    const asRange = await getReportProductivityRange(WORKING_DATE, WORKING_DATE);
    const asDay = await getReportProductivity(WORKING_DATE);

    expect(asRange.days).toEqual([WORKING_DATE]);
    expect(asRange.regions.map((r) => r.productivity)).toEqual(
      asDay.regions.map((r) => r.productivity),
    );
  });

  it("skips days with no completed report instead of failing the range", async () => {
    mocks.findLatestCompletedSessionByReportDate.mockImplementation(
      async (date: string) =>
        date === "2026-07-16"
          ? null
          : { id: "session-1", daily_call_plan_report_id: "report-1" },
    );

    const range = await getReportProductivityRange("2026-07-15", "2026-07-17");

    expect(range.days).toEqual(["2026-07-15", "2026-07-17"]);
    expect(range.missingDays).toEqual(["2026-07-16"]);
    // Two days counted, not three.
    const chennaiEntry = range.regions.find((r) => r.regionId === chennai.id);
    expect(chennaiEntry?.productivity.list[0]?.assigned).toBe(4);
  });

  it("takes a frozen day's snapshot and a live day's compute in one range", async () => {
    await closeRegionEod(superAdmin, chennai.id, "2026-07-16");
    // The day's rows change after the freeze; the frozen day must not follow.
    mocks.findProductivityRowsByReportId.mockResolvedValue(
      persistedRows([
        { ticketId: "W1", engineer: "Ravi", morning: "Scheduled" },
      ]),
    );

    const range = await getReportProductivityRange("2026-07-15", "2026-07-16");

    const chennaiEntry = range.regions.find((r) => r.regionId === chennai.id);
    expect(chennaiEntry?.source).toBe("MIXED");
    // 15th live (1 assigned, post-edit rows) + 16th frozen (2 assigned).
    expect(chennaiEntry?.productivity.list[0]?.assigned).toBe(3);

    const velloreEntry = range.regions.find((r) => r.regionId === vellore.id);
    expect(velloreEntry?.source).toBe("LIVE");
  });

  it("swaps a reversed pair rather than returning nothing", async () => {
    const range = await getReportProductivityRange("2026-07-17", "2026-07-15");

    expect(range.from).toBe("2026-07-15");
    expect(range.to).toBe("2026-07-17");
    expect(range.days).toHaveLength(3);
  });

  it("refuses a range longer than it will read in one request", async () => {
    await expect(
      getReportProductivityRange("2026-01-01", "2026-12-31"),
    ).rejects.toThrow(/at most 92 days/);
  });
});

describe("getReportProductivityRange callsInPeriod", () => {
  /**
   * The number that tells "this region booked nothing" apart from "this region
   * did nothing". Vellore read 5 assigned against 6,840 calls in production and
   * looked broken; without the denominator that is indistinguishable from a
   * region with no work at all.
   */
  it("counts every visible call a region had, not just the booked ones", async () => {
    // Chennai: 2 rows, both Scheduled with an engineer. Vellore: 1 row, but its
    // status is NOT Scheduled — a call it had and did not book.
    mocks.findProductivityRowsByReportId.mockResolvedValue(
      persistedRows([
        { ticketId: "W1", engineer: "Ravi", morning: "Scheduled" },
        { ticketId: "W2", engineer: "Ravi", morning: "Scheduled" },
        { ticketId: "V1", engineer: "Vel", morning: "Actionable", workLocation: vellore.code },
      ]),
    );

    const range = await getReportProductivityRange("2026-07-15", "2026-07-16");

    const chennaiEntry = range.regions.find((r) => r.regionId === chennai.id);
    expect(chennaiEntry?.callsInPeriod).toBe(4); // 2 rows over 2 days
    expect(chennaiEntry?.productivity.list[0]?.assigned).toBe(4);

    const velloreEntry = range.regions.find((r) => r.regionId === vellore.id);
    // The call is there both days and is counted...
    expect(velloreEntry?.callsInPeriod).toBe(2);
    // ...but none of it was booked as Scheduled, so nothing is assigned.
    expect(velloreEntry?.productivity.list).toHaveLength(0);
    expect(velloreEntry?.productivity.totalAttended).toBe(0);
  });

  it("still counts calls on a day where every region is frozen", async () => {
    // Freeze both regions for the 16th: without countCalls forcing the read,
    // that day's rows are never loaded and its calls would go uncounted.
    await closeRegionEod(superAdmin, chennai.id, "2026-07-16");
    await closeRegionEod(superAdmin, vellore.id, "2026-07-16");

    const range = await getReportProductivityRange("2026-07-16", "2026-07-16");

    const chennaiEntry = range.regions.find((r) => r.regionId === chennai.id);
    expect(chennaiEntry?.source).toBe("FROZEN");
    expect(chennaiEntry?.callsInPeriod).toBe(2);
  });
});
