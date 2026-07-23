import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { getMeController } from "./meController.js";

const mocks = vi.hoisted(() => ({
  findManagedUserById: vi.fn(),
  findAdditionalRegionIdsForUser: vi.fn(),
}));

vi.mock("../repositories/userRepository.js", () => ({
  findManagedUserById: mocks.findManagedUserById,
}));

vi.mock("../repositories/userRegionRepository.js", () => ({
  findAdditionalRegionIdsForUser: mocks.findAdditionalRegionIdsForUser,
}));

vi.mock("../services/userManagement/userManagementService.js", () => ({
  changeOwnPassword: vi.fn(),
}));

vi.mock("../services/audit/activityLogger.js", () => ({
  recordActivity: vi.fn(),
}));

function makeManagedUser(regionId: string | null) {
  return {
    id: "user-1",
    email: "admin@example.com",
    username: "admin",
    role: "REGION_ADMIN",
    regionId,
    isActive: true,
    mustChangePassword: false,
    accessibleSections: null,
    lastLoginAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    createdBy: null,
    updatedAt: "2026-01-01T00:00:00Z",
    updatedBy: null,
    deactivatedAt: null,
    deactivatedBy: null,
  };
}

function makeRequest(overrides: Record<string, unknown> = {}): Request {
  return {
    currentUser: {
      id: "user-1",
      email: "admin@example.com",
      username: "admin",
      role: "REGION_ADMIN",
      regionId: "region-primary",
      region_id: "region-primary",
      mustChangePassword: false,
      accessibleSections: null,
      ...overrides,
    },
  } as unknown as Request;
}

// asyncHandler returns void and settles on a later tick; wait for either the
// response or the error path, and surface any error loudly.
async function invokeGetMe(request: Request): Promise<ReturnType<typeof vi.fn>> {
  const json = vi.fn();
  const next = vi.fn();
  getMeController(request, { json } as unknown as Response, next);
  await new Promise((resolve) => setImmediate(resolve));
  expect(next.mock.calls).toEqual([]);
  return json;
}

describe("getMeController", () => {
  beforeEach(() => {
    mocks.findManagedUserById.mockReset();
    mocks.findAdditionalRegionIdsForUser.mockReset();
    mocks.findAdditionalRegionIdsForUser.mockResolvedValue([]);
  });

  it("includes additionalRegionIds and allowedRegionIds for a multi-region REGION_ADMIN", async () => {
    mocks.findManagedUserById.mockResolvedValue(makeManagedUser("region-primary"));
    mocks.findAdditionalRegionIdsForUser.mockResolvedValue([
      "region-extra-1",
      "region-extra-2",
    ]);

    const json = await invokeGetMe(makeRequest());

    expect(json).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "user-1",
        additionalRegionIds: ["region-extra-1", "region-extra-2"],
        allowedRegionIds: [
          "region-primary",
          "region-extra-1",
          "region-extra-2",
        ],
      }),
    });
  });

  it("returns empty extras for a single-region REGION_ADMIN", async () => {
    mocks.findManagedUserById.mockResolvedValue(makeManagedUser("region-primary"));

    const json = await invokeGetMe(makeRequest());

    expect(json).toHaveBeenCalledWith({
      data: expect.objectContaining({
        additionalRegionIds: [],
        allowedRegionIds: ["region-primary"],
      }),
    });
  });

  it("reports SUPER_ADMIN as unrestricted (allowedRegionIds null)", async () => {
    mocks.findManagedUserById.mockResolvedValue({
      ...makeManagedUser(null),
      role: "SUPER_ADMIN",
    });

    const json = await invokeGetMe(
      makeRequest({ role: "SUPER_ADMIN", regionId: null, region_id: null }),
    );

    expect(json).toHaveBeenCalledWith({
      data: expect.objectContaining({
        additionalRegionIds: [],
        allowedRegionIds: null,
      }),
    });
    expect(mocks.findAdditionalRegionIdsForUser).not.toHaveBeenCalled();
  });
});
