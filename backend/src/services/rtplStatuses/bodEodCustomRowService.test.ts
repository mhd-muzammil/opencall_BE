import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyProductivityStatus,
  isAttendedOutcomeStatus,
  setCustomBodEodRows,
  setStatusBucketMap,
  statusInBodEodRow,
  withCustomBodEodRows,
  type CustomBodEodRow,
} from "@opencall/shared";
import type { AuthenticatedUser } from "../../types/auth.js";

const mocks = vi.hoisted(() => ({
  findBodEodCustomRowById: vi.fn(),
  findBodEodCustomRowByLabel: vi.fn(),
  insertBodEodCustomRow: vi.fn(),
  updateBodEodCustomRow: vi.fn(),
  deleteBodEodCustomRow: vi.fn(),
  listStatusNamesForRow: vi.fn(),
  listBodEodCustomRows: vi.fn(),
  invalidateStatusBuckets: vi.fn(),
}));

vi.mock("../../repositories/bodEodCustomRowRepository.js", () => mocks);
vi.mock("../../repositories/activityLogRepository.js", () => ({ insertActivity: vi.fn() }));
vi.mock("./statusBucketCache.js", () => ({
  invalidateStatusBuckets: mocks.invalidateStatusBuckets,
  toCustomBodEodRows: (rows: unknown[]) => rows,
}));

const {
  createBodEodCustomRowService,
  deleteBodEodCustomRowService,
  listBodEodCustomRowsService,
} = await import("./bodEodCustomRowService.js");

const admin = { id: "u1", email: "a@x", role: "SUPER_ADMIN", regionId: null } as unknown as AuthenticatedUser;

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    key: "C_abc1234567",
    label: "HP Approval",
    productivityBucket: "ATTENDED_OTHER",
    afterRow: "TO_BE_CANCEL",
    sortOrder: 10,
    isActive: true,
    statusCount: 0,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findBodEodCustomRowByLabel.mockResolvedValue(null);
  mocks.insertBodEodCustomRow.mockImplementation(async (input) => record(input));
});

describe("creating a custom row", () => {
  it("stores it with a generated key and refreshes the mapping", async () => {
    const row = await createBodEodCustomRowService(admin, {
      label: "HP Approval",
      productivityBucket: "CX_RESCHEDULE",
      afterRow: "CX_RESCHEDULE",
    });
    expect(row.key).toMatch(/^C_[0-9a-f]{10}$/);
    expect(mocks.insertBodEodCustomRow).toHaveBeenCalledWith(
      expect.objectContaining({ label: "HP Approval", productivityBucket: "CX_RESCHEDULE", afterRow: "CX_RESCHEDULE" }),
    );
    expect(mocks.invalidateStatusBuckets).toHaveBeenCalled();
  });

  it("requires a name and a productivity choice; CLOSED is not offered", async () => {
    await expect(createBodEodCustomRowService(admin, { productivityBucket: "ATTENDED_OTHER" }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(createBodEodCustomRowService(admin, { label: "X" }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(createBodEodCustomRowService(admin, { label: "X", productivityBucket: "CLOSED" }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses a name a built-in or existing row already has", async () => {
    await expect(
      createBodEodCustomRowService(admin, { label: "ssc pending", productivityBucket: "PART_ORDER" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    mocks.findBodEodCustomRowByLabel.mockResolvedValue(record());
    await expect(
      createBodEodCustomRowService(admin, { label: "HP Approval", productivityBucket: "ATTENDED_OTHER" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("deleting a custom row", () => {
  it("is refused while statuses still point at it", async () => {
    mocks.findBodEodCustomRowById.mockResolvedValue(record());
    mocks.listStatusNamesForRow.mockResolvedValue(["Waiting for HP Approval"]);
    await expect(deleteBodEodCustomRowService(admin, "r1")).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.deleteBodEodCustomRow).not.toHaveBeenCalled();
  });

  it("goes through once no status uses it", async () => {
    mocks.findBodEodCustomRowById.mockResolvedValue(record());
    mocks.listStatusNamesForRow.mockResolvedValue([]);
    await deleteBodEodCustomRowService(admin, "r1");
    expect(mocks.deleteBodEodCustomRow).toHaveBeenCalledWith("r1");
  });
});

it("lists nothing (instead of failing) before migration 069", async () => {
  mocks.listBodEodCustomRows.mockRejectedValue(Object.assign(new Error("no table"), { code: "42P01" }));
  await expect(listBodEodCustomRowsService()).resolves.toEqual([]);
});

describe("shared: statuses on a custom row", () => {
  const row: CustomBodEodRow = {
    key: "C_abc1234567",
    label: "HP Approval",
    productivityBucket: "CX_RESCHEDULE",
    afterRow: "CX_RESCHEDULE",
    sortOrder: 10,
    isActive: true,
  };

  afterEach(() => {
    setCustomBodEodRows([]);
    setStatusBucketMap([]);
  });

  it("count under that row only, and in productivity as the row says", () => {
    setCustomBodEodRows([row]);
    setStatusBucketMap([{ name: "Waiting for HP Approval", bucket: row.key }]);
    expect(statusInBodEodRow("Waiting for HP Approval", row.key)).toBe(true);
    expect(statusInBodEodRow("Waiting for HP Approval", "OTHER")).toBe(false);
    expect(classifyProductivityStatus("Waiting for HP Approval")).toBe("CX_RESCHEDULE");
    expect(isAttendedOutcomeStatus("Waiting for HP Approval")).toBe(false);
  });

  it("an unmapped status never lands on a custom row by keyword", () => {
    setCustomBodEodRows([row]);
    expect(statusInBodEodRow("HP Approval", row.key)).toBe(false);
  });

  it("a status pointing at a deleted row counts as attended", () => {
    setStatusBucketMap([{ name: "Orphan", bucket: "C_gone000000" }]);
    expect(classifyProductivityStatus("Orphan")).toBe("ATTENDED_OTHER");
  });

  it("withCustomBodEodRows slots rows after their anchor, hidden ones left out", () => {
    setCustomBodEodRows([
      row,
      { ...row, key: "C_def1234567", label: "Hidden", isActive: false },
      { ...row, key: "C_ghi1234567", label: "Orphaned anchor", afterRow: "ENGINEER_DELAY" },
    ]);
    const builtins = ["toBeSchedule", "cxReschedule", "sscPending"];
    const anchors: Record<string, "TO_BE_SCHEDULE" | "CX_RESCHEDULE" | "SSC_PENDING"> = {
      toBeSchedule: "TO_BE_SCHEDULE",
      cxReschedule: "CX_RESCHEDULE",
      sscPending: "SSC_PENDING",
    };
    const laid = withCustomBodEodRows(builtins, (k) => anchors[k], (r) => r.label);
    expect(laid).toEqual(["toBeSchedule", "cxReschedule", "HP Approval", "sscPending", "Orphaned anchor"]);
  });
});
