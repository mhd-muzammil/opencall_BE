import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../../types/auth.js";
import type { Region } from "../../repositories/regionRepository.js";
import { findAllowedRegionsForUser } from "./regionAccessService.js";

const mocks = vi.hoisted(() => ({
  findRegionById: vi.fn(),
  findAdditionalRegionIdsForUser: vi.fn(),
}));

vi.mock("../../repositories/regionRepository.js", () => ({
  findRegionById: mocks.findRegionById,
}));

vi.mock("../../repositories/userRegionRepository.js", () => ({
  findAdditionalRegionIdsForUser: mocks.findAdditionalRegionIdsForUser,
}));

function makeUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: "user-1",
    email: "admin@example.com",
    username: "admin",
    role: "REGION_ADMIN",
    regionId: "region-primary",
    region_id: "region-primary",
    mustChangePassword: false,
    accessibleSections: null,
    ...overrides,
  };
}

function makeRegion(id: string): Region {
  return {
    id,
    code: id.toUpperCase(),
    name: `Region ${id}`,
    isActive: true,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

describe("findAllowedRegionsForUser", () => {
  beforeEach(() => {
    mocks.findRegionById.mockReset();
    mocks.findAdditionalRegionIdsForUser.mockReset();
    mocks.findAdditionalRegionIdsForUser.mockResolvedValue([]);
  });

  it("returns null for SUPER_ADMIN (unrestricted)", async () => {
    const result = await findAllowedRegionsForUser(
      makeUser({ role: "SUPER_ADMIN", regionId: null, region_id: null }),
    );

    expect(result).toBeNull();
    expect(mocks.findRegionById).not.toHaveBeenCalled();
    expect(mocks.findAdditionalRegionIdsForUser).not.toHaveBeenCalled();
  });

  it("returns primary plus additional regions for REGION_ADMIN", async () => {
    mocks.findAdditionalRegionIdsForUser.mockResolvedValue([
      "region-extra",
    ]);
    mocks.findRegionById.mockImplementation(async (id: string) =>
      makeRegion(id),
    );

    const result = await findAllowedRegionsForUser(makeUser());

    expect(result?.map((region) => region.id)).toEqual([
      "region-primary",
      "region-extra",
    ]);
  });

  it("dedupes when the primary region also appears in user_regions", async () => {
    mocks.findAdditionalRegionIdsForUser.mockResolvedValue([
      "region-primary",
      "region-extra",
    ]);
    mocks.findRegionById.mockImplementation(async (id: string) =>
      makeRegion(id),
    );

    const result = await findAllowedRegionsForUser(makeUser());

    expect(result?.map((region) => region.id)).toEqual([
      "region-primary",
      "region-extra",
    ]);
    expect(mocks.findRegionById).toHaveBeenCalledTimes(2);
  });

  it("skips region ids that no longer resolve to a region", async () => {
    mocks.findAdditionalRegionIdsForUser.mockResolvedValue(["region-gone"]);
    mocks.findRegionById.mockImplementation(async (id: string) =>
      id === "region-gone" ? null : makeRegion(id),
    );

    const result = await findAllowedRegionsForUser(makeUser());

    expect(result?.map((region) => region.id)).toEqual(["region-primary"]);
  });

  it("throws forbidden when a REGION_ADMIN resolves to no regions", async () => {
    mocks.findAdditionalRegionIdsForUser.mockResolvedValue([]);

    await expect(
      findAllowedRegionsForUser(makeUser({ regionId: null, region_id: null })),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "REGION_ADMIN user is not assigned to a region",
    });
  });
});
