import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../../types/auth.js";

const mocks = vi.hoisted(() => ({
  findRtplStatusById: vi.fn(),
  findRtplStatusByName: vi.fn(),
  insertRtplStatus: vi.fn(),
  updateRtplStatus: vi.fn(),
  setRtplStatusActive: vi.fn(),
  deleteRtplStatus: vi.fn(),
  renameRtplStatusValueInReportRows: vi.fn(),
  invalidateStatusBuckets: vi.fn(),
  findBodEodCustomRowByKey: vi.fn(),
}));

vi.mock("../../repositories/rtplStatusRepository.js", () => ({
  ...mocks,
  listRtplStatuses: vi.fn(),
  listRtplStatusesForDropdown: vi.fn(),
  listRtplStatusBuckets: vi.fn(),
}));
vi.mock("../../repositories/activityLogRepository.js", () => ({
  insertActivity: vi.fn(),
}));
vi.mock("./statusBucketCache.js", () => ({
  invalidateStatusBuckets: mocks.invalidateStatusBuckets,
}));
vi.mock("../../repositories/bodEodCustomRowRepository.js", () => ({
  findBodEodCustomRowByKey: mocks.findBodEodCustomRowByKey,
}));

const {
  createRtplStatusService,
  deleteRtplStatusService,
  setRtplStatusActiveService,
  updateRtplStatusService,
} = await import("./rtplStatusService.js");

const admin = {
  id: "u1",
  email: "a@example.com",
  role: "SUPER_ADMIN",
  regionId: null,
} as unknown as AuthenticatedUser;

function status(name: string, bodEodBucket: string | null) {
  return {
    id: "s1",
    name,
    category: "General Activity",
    bodEodBucket,
    sortOrder: 0,
    isActive: true,
    createdBy: null,
    updatedBy: null,
    createdAt: "",
    updatedAt: "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRtplStatusByName.mockResolvedValue(null);
  mocks.insertRtplStatus.mockImplementation(async (input) =>
    status(input.name, input.bodEodBucket),
  );
  mocks.updateRtplStatus.mockImplementation(async (_id, input) =>
    status(input.name ?? "x", input.bodEodBucket ?? null),
  );
});

describe("creating a status", () => {
  it("requires the BOD/EOD row", async () => {
    await expect(
      createRtplStatusService(admin, { name: "Waiting on Client" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      createRtplStatusService(admin, { name: "Waiting on Client", bodEodBucket: "NOPE" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.insertRtplStatus).not.toHaveBeenCalled();
  });

  it("stores the chosen row and refreshes the backend mapping", async () => {
    const created = await createRtplStatusService(admin, {
      name: "Waiting on Client",
      bodEodBucket: "CX_RESCHEDULE",
    });
    expect(created.bodEodBucket).toBe("CX_RESCHEDULE");
    expect(mocks.invalidateStatusBuckets).toHaveBeenCalled();
  });
});

describe("custom rows", () => {
  it("a status can be put on a custom row that exists and is shown", async () => {
    mocks.findBodEodCustomRowByKey.mockResolvedValue({ key: "C_abc1234567", isActive: true });
    const created = await createRtplStatusService(admin, {
      name: "Waiting for HP Approval",
      bodEodBucket: "C_abc1234567",
    });
    expect(created.bodEodBucket).toBe("C_abc1234567");
  });

  it("not on a hidden or unknown one", async () => {
    mocks.findBodEodCustomRowByKey.mockResolvedValue({ key: "C_abc1234567", isActive: false });
    await expect(
      createRtplStatusService(admin, { name: "A", bodEodBucket: "C_abc1234567" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    mocks.findBodEodCustomRowByKey.mockResolvedValue(null);
    await expect(
      createRtplStatusService(admin, { name: "A", bodEodBucket: "C_zzz9999999" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("a status already on a hidden row may keep it while other fields change", async () => {
    mocks.findRtplStatusById.mockResolvedValue(status("Waiting", "C_abc1234567"));
    mocks.findBodEodCustomRowByKey.mockResolvedValue({ key: "C_abc1234567", isActive: false });
    await expect(
      updateRtplStatusService(admin, "s1", { category: "X", bodEodBucket: "C_abc1234567" }),
    ).resolves.toBeDefined();
  });
});

describe("changing a status's row", () => {
  it("saves the new row", async () => {
    mocks.findRtplStatusById.mockResolvedValue(status("Visit Estimate", "OTHER"));
    const { status: updated } = await updateRtplStatusService(admin, "s1", {
      bodEodBucket: "TO_BE_SCHEDULE",
    });
    expect(mocks.updateRtplStatus).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ bodEodBucket: "TO_BE_SCHEDULE" }),
    );
    expect(updated.bodEodBucket).toBe("TO_BE_SCHEDULE");
    expect(mocks.invalidateStatusBuckets).toHaveBeenCalled();
  });

  it("a rename keeps the row (it is stored, not read from the name)", async () => {
    mocks.findRtplStatusById.mockResolvedValue(status("CX Pending", "CX_RESCHEDULE"));
    mocks.renameRtplStatusValueInReportRows.mockResolvedValue(0);
    await updateRtplStatusService(admin, "s1", { name: "Client Waiting" });
    expect(mocks.updateRtplStatus).toHaveBeenCalledWith(
      "s1",
      expect.not.objectContaining({ bodEodBucket: expect.anything() }),
    );
  });
});

describe("system statuses are locked", () => {
  it.each(["Scheduled", "Customer Pending", "Case-closed"])(
    "%s cannot be renamed, moved, disabled or deleted",
    async (name) => {
      mocks.findRtplStatusById.mockResolvedValue(status(name, null));
      await expect(
        updateRtplStatusService(admin, "s1", { name: `${name} 2` }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        updateRtplStatusService(admin, "s1", { bodEodBucket: "OTHER" }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(setRtplStatusActiveService(admin, "s1", false)).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(deleteRtplStatusService(admin, "s1")).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(mocks.deleteRtplStatus).not.toHaveBeenCalled();
    },
  );

  it("can still change category and order", async () => {
    mocks.findRtplStatusById.mockResolvedValue(status("Scheduled", "SCHEDULED"));
    await expect(
      updateRtplStatusService(admin, "s1", { category: "Scheduling", sortOrder: 5 }),
    ).resolves.toBeDefined();
  });
});
