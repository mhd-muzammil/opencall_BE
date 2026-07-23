import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../../types/auth.js";
import type { Region } from "../../repositories/regionRepository.js";
import {
  findAllowedRegionIdsForUser,
  findAllowedRegionsForUser,
  resolveEffectiveRegionId,
} from "./regionAccessService.js";

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

describe("resolveEffectiveRegionId", () => {
  beforeEach(() => {
    mocks.findRegionById.mockReset();
    mocks.findAdditionalRegionIdsForUser.mockReset();
    mocks.findAdditionalRegionIdsForUser.mockResolvedValue([]);
  });

  it("returns the requested region unrestricted for SUPER_ADMIN", async () => {
    const superAdmin = makeUser({
      role: "SUPER_ADMIN",
      regionId: null,
      region_id: null,
    });

    await expect(
      resolveEffectiveRegionId(superAdmin, "region-anything"),
    ).resolves.toBe("region-anything");
    await expect(resolveEffectiveRegionId(superAdmin, null)).resolves.toBeNull();
    expect(mocks.findAdditionalRegionIdsForUser).not.toHaveBeenCalled();
  });

  it("defaults to the primary region when no region is requested", async () => {
    await expect(resolveEffectiveRegionId(makeUser(), null)).resolves.toBe(
      "region-primary",
    );
    await expect(resolveEffectiveRegionId(makeUser(), "   ")).resolves.toBe(
      "region-primary",
    );
    expect(mocks.findAdditionalRegionIdsForUser).not.toHaveBeenCalled();
  });

  it("allows the primary region without a user_regions lookup", async () => {
    await expect(
      resolveEffectiveRegionId(makeUser(), "region-primary"),
    ).resolves.toBe("region-primary");
    expect(mocks.findAdditionalRegionIdsForUser).not.toHaveBeenCalled();
  });

  it("allows EACH additional region (the previously-failing case)", async () => {
    mocks.findAdditionalRegionIdsForUser.mockResolvedValue([
      "region-extra-1",
      "region-extra-2",
    ]);

    await expect(
      resolveEffectiveRegionId(makeUser(), "region-extra-1"),
    ).resolves.toBe("region-extra-1");
    await expect(
      resolveEffectiveRegionId(makeUser(), "region-extra-2"),
    ).resolves.toBe("region-extra-2");
  });

  it("still rejects a region the user does not hold with 403", async () => {
    mocks.findAdditionalRegionIdsForUser.mockResolvedValue(["region-extra-1"]);

    await expect(
      resolveEffectiveRegionId(makeUser(), "region-not-mine"),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "REGION_ADMIN cannot access another region",
    });
  });

  it("throws forbidden for a REGION_ADMIN with no regions at all", async () => {
    mocks.findAdditionalRegionIdsForUser.mockResolvedValue([]);
    const unassigned = makeUser({ regionId: null, region_id: null });

    await expect(resolveEffectiveRegionId(unassigned, null)).rejects.toMatchObject(
      {
        statusCode: 403,
        message: "REGION_ADMIN user is not assigned to a region",
      },
    );
    await expect(
      resolveEffectiveRegionId(unassigned, "region-anything"),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "REGION_ADMIN user is not assigned to a region",
    });
  });

  it("allows a held additional region even without a primary region", async () => {
    mocks.findAdditionalRegionIdsForUser.mockResolvedValue(["region-extra-1"]);

    await expect(
      resolveEffectiveRegionId(
        makeUser({ regionId: null, region_id: null }),
        "region-extra-1",
      ),
    ).resolves.toBe("region-extra-1");
  });
});

// The regression test that would have caught this bug: the write path
// (resolveEffectiveRegionId) and the read path (findAllowedRegionsForUser)
// must agree on the same allowed set, in both directions.
describe("read/write region set consistency", () => {
  beforeEach(() => {
    mocks.findRegionById.mockReset();
    mocks.findAdditionalRegionIdsForUser.mockReset();
  });

  it("every readable region is actionable, and every actionable region is readable", async () => {
    const user = makeUser();
    mocks.findAdditionalRegionIdsForUser.mockResolvedValue([
      "region-extra-1",
      "region-extra-2",
    ]);
    mocks.findRegionById.mockImplementation(async (id: string) =>
      makeRegion(id),
    );

    const readable = await findAllowedRegionsForUser(user);
    expect(readable).not.toBeNull();

    // read -> write: everything visible must be actionable.
    for (const region of readable ?? []) {
      await expect(resolveEffectiveRegionId(user, region.id)).resolves.toBe(
        region.id,
      );
    }

    // write -> read: everything actionable must be visible.
    const allowedIds = (await findAllowedRegionIdsForUser(user)) ?? [];
    expect(allowedIds.length).toBeGreaterThan(0);
    const readableIds = (readable ?? []).map((region) => region.id);
    for (const regionId of allowedIds) {
      expect(readableIds).toContain(regionId);
    }
  });
});
