import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineerProductivityResult } from "@opencall/shared";
import type { AuthenticatedUser } from "../../types/auth.js";
import type { GeneratedDailyCallPlanReport } from "../../types/reportGeneration.js";

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

vi.mock("../callPlanGenerator/dailyCallPlanGenerator.js", () => ({
  generateDailyCallPlanReport: mocks.generateDailyCallPlanReport,
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

function reportWithRows(
  rows: Array<{
    ticketId: string;
    engineer: string;
    morning?: string;
    evening?: string;
    workLocation?: string;
    sameDayClosed?: boolean;
  }>,
): GeneratedDailyCallPlanReport {
  return {
    rows: rows.map((row, index) => ({
      serialNo: index + 1,
      output: {
        "Ticket ID": row.ticketId,
        Engineer: row.engineer,
        "RTPL status": row.morning ?? "",
        "Evening status": row.evening ?? "",
        "Work Location": row.workLocation ?? chennai.code,
        "Flex Status": "Open",
      },
      carryForward: {
        closedSyntheticRow: row.sameDayClosed ?? false,
        sameDayClosedRow: row.sameDayClosed ?? false,
      },
      comparison: null,
    })),
  } as unknown as GeneratedDailyCallPlanReport;
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
    flex_upload_batch_id: "6f5b0000-0000-4000-8000-000000000001",
    renderways_upload_batch_id: null,
    call_plan_upload_batch_id: null,
  });
  mocks.findAllowedRegionsForUser.mockImplementation(
    async (user: AuthenticatedUser) =>
      user.role === "SUPER_ADMIN" ? null : [chennai],
  );
  mocks.generateDailyCallPlanReport.mockResolvedValue(
    reportWithRows([
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
    mocks.generateDailyCallPlanReport.mockResolvedValue(
      reportWithRows([
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
    const read = await getReportProductivity(superAdmin, WORKING_DATE);
    const chennaiEntry = read.regions.find((r) => r.regionId === chennai.id);
    expect(chennaiEntry?.source).toBe("FROZEN");
    expect(chennaiEntry?.productivity).toEqual(first.snapshot);
  });

  it("keeps other regions live and independent after one region closes", async () => {
    await closeRegionEod(superAdmin, chennai.id, WORKING_DATE);

    const read = await getReportProductivity(superAdmin, WORKING_DATE);
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

    const read = await getReportProductivity(superAdmin, WORKING_DATE);
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
