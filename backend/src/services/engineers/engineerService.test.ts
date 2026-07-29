import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateEngineerService } from "./engineerService.js";
import type { AuthenticatedUser } from "../../types/auth.js";

const mocks = vi.hoisted(() => ({
  findEngineerById: vi.fn(),
  findEngineerByNameInRegion: vi.fn(),
  updateEngineer: vi.fn(),
  deleteEngineer: vi.fn(),
  renameEngineerInHistoricalRows: vi.fn(),
  insertActivity: vi.fn(),
  findRegionById: vi.fn(),
  withTransaction: vi.fn(),
  fakeClient: { query: vi.fn() },
}));

vi.mock("../../repositories/engineerRepository.js", () => ({
  findEngineerById: mocks.findEngineerById,
  findEngineerByNameInRegion: mocks.findEngineerByNameInRegion,
  insertEngineer: vi.fn(),
  listEngineers: vi.fn(),
  listEngineersForDropdown: vi.fn(),
  renameEngineerInHistoricalRows: mocks.renameEngineerInHistoricalRows,
  setEngineerActive: vi.fn(),
  updateEngineer: mocks.updateEngineer,
  deleteEngineer: mocks.deleteEngineer,
}));

vi.mock("../../repositories/activityLogRepository.js", () => ({
  insertActivity: mocks.insertActivity,
}));

vi.mock("../../repositories/regionRepository.js", () => ({
  findRegionById: mocks.findRegionById,
}));

vi.mock("../../config/database.js", () => ({
  withTransaction: mocks.withTransaction,
}));

const CHENNAI_REGION_ID = "region-chennai";
const OTHER_REGION_ID = "region-vellore";

const superAdmin: AuthenticatedUser = {
  id: "user-1",
  email: "admin@example.com",
  role: "SUPER_ADMIN",
  regionId: null,
} as AuthenticatedUser;

const chennaiAdmin: AuthenticatedUser = {
  id: "user-2",
  email: "chennai@example.com",
  role: "REGION_ADMIN",
  regionId: CHENNAI_REGION_ID,
} as AuthenticatedUser;

function engineer(overrides: Record<string, unknown> = {}) {
  return {
    id: "eng-1",
    engineerCode: null,
    engineerName: "Jeeva",
    regionId: CHENNAI_REGION_ID,
    email: null,
    phone: null,
    hpId: "",
    vendorId: "",
    isActive: true,
    createdBy: null,
    updatedBy: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // withTransaction just runs the callback with a fake client.
  mocks.withTransaction.mockImplementation(async (cb: (c: unknown) => Promise<unknown>) =>
    cb(mocks.fakeClient),
  );
  mocks.insertActivity.mockResolvedValue(undefined);
  mocks.findRegionById.mockResolvedValue({
    id: CHENNAI_REGION_ID,
    code: "ASPS01461",
    name: "Chennai",
    isActive: true,
    createdAt: "2026-01-01",
  });
  mocks.findEngineerByNameInRegion.mockResolvedValue(null);
  mocks.renameEngineerInHistoricalRows.mockResolvedValue({
    reportRows: 13,
    callPlanRecords: 4,
  });
});

describe("updateEngineerService — rename remaps historical rows", () => {
  it("remaps historical name strings when the engineer is renamed", async () => {
    mocks.findEngineerById.mockResolvedValue(engineer());
    mocks.updateEngineer.mockResolvedValue(engineer({ engineerName: "Jeeva CH" }));

    const result = await updateEngineerService(superAdmin, "eng-1", {
      engineerName: "Jeeva CH",
    });

    // The remap ran inside the same transaction, scoped to the engineer's
    // region (id + its ASP work-location codes), old name -> new name.
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.updateEngineer).toHaveBeenCalledWith(
      "eng-1",
      expect.objectContaining({ engineerName: "Jeeva CH" }),
      mocks.fakeClient,
    );
    expect(mocks.renameEngineerInHistoricalRows).toHaveBeenCalledWith(
      mocks.fakeClient,
      "Jeeva",
      "Jeeva CH",
      { regionId: CHENNAI_REGION_ID, aspCodes: ["ASPS01461"] },
    );
    expect(result.remappedHistory).toEqual({ reportRows: 13, callPlanRecords: 4 });

    // Audit trail records what was remapped.
    expect(mocks.insertActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "ENGINEER_UPDATED",
        metadata: expect.objectContaining({
          renamedFrom: "Jeeva",
          renamedTo: "Jeeva CH",
          remappedReportRows: 13,
          remappedCallPlanRecords: 4,
        }),
      }),
    );
  });

  it("treats a casing-only change as a rename (normalises historical casing)", async () => {
    mocks.findEngineerById.mockResolvedValue(engineer({ engineerName: "JEEVA CH" }));
    mocks.updateEngineer.mockResolvedValue(engineer({ engineerName: "Jeeva CH" }));

    await updateEngineerService(superAdmin, "eng-1", { engineerName: "Jeeva CH" });

    expect(mocks.renameEngineerInHistoricalRows).toHaveBeenCalledWith(
      mocks.fakeClient,
      "JEEVA CH",
      "Jeeva CH",
      expect.anything(),
    );
  });

  it("does NOT remap when the name is unchanged", async () => {
    mocks.findEngineerById.mockResolvedValue(engineer());
    mocks.updateEngineer.mockResolvedValue(engineer({ phone: "12345" }));

    const result = await updateEngineerService(superAdmin, "eng-1", {
      phone: "12345",
    });

    expect(mocks.renameEngineerInHistoricalRows).not.toHaveBeenCalled();
    expect(result.remappedHistory).toEqual({ reportRows: 0, callPlanRecords: 0 });
  });

  it("rejects a rename onto another engineer's name in the same region", async () => {
    mocks.findEngineerById.mockResolvedValue(engineer());
    mocks.findEngineerByNameInRegion.mockResolvedValue(
      engineer({ id: "eng-2", engineerName: "Jeeva CH" }),
    );

    await expect(
      updateEngineerService(superAdmin, "eng-1", { engineerName: "Jeeva CH" }),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Collision lookup excluded the engineer being renamed.
    expect(mocks.findEngineerByNameInRegion).toHaveBeenCalledWith(
      "Jeeva CH",
      CHENNAI_REGION_ID,
      "eng-1",
    );
    expect(mocks.updateEngineer).not.toHaveBeenCalled();
    expect(mocks.renameEngineerInHistoricalRows).not.toHaveBeenCalled();
  });

  it("rejects renaming to an empty name", async () => {
    mocks.findEngineerById.mockResolvedValue(engineer());

    await expect(
      updateEngineerService(superAdmin, "eng-1", { engineerName: "   " }),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(mocks.updateEngineer).not.toHaveBeenCalled();
  });

  it("still remaps with region-id-only scope when the region record is missing", async () => {
    mocks.findEngineerById.mockResolvedValue(engineer());
    mocks.updateEngineer.mockResolvedValue(engineer({ engineerName: "Jeeva CH" }));
    mocks.findRegionById.mockResolvedValue(null);

    await updateEngineerService(superAdmin, "eng-1", { engineerName: "Jeeva CH" });

    expect(mocks.renameEngineerInHistoricalRows).toHaveBeenCalledWith(
      mocks.fakeClient,
      "Jeeva",
      "Jeeva CH",
      { regionId: CHENNAI_REGION_ID, aspCodes: [] },
    );
  });

  it("forbids a region admin from renaming another region's engineer", async () => {
    mocks.findEngineerById.mockResolvedValue(engineer({ regionId: OTHER_REGION_ID }));

    await expect(
      updateEngineerService(chennaiAdmin, "eng-1", { engineerName: "Jeeva CH" }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(mocks.updateEngineer).not.toHaveBeenCalled();
    expect(mocks.renameEngineerInHistoricalRows).not.toHaveBeenCalled();
  });
});
