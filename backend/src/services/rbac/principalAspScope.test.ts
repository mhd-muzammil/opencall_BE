import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import type { AuthenticatedUser, SpecialAccessPrincipal } from "../../types/auth.js";
import type { Region } from "../../repositories/regionRepository.js";
import { allowedAspCodesForRequest, aspScopeToArray } from "./principalAspScope.js";

const mocks = vi.hoisted(() => ({
  findRegionById: vi.fn(),
}));

vi.mock("../../repositories/regionRepository.js", () => ({
  findRegionById: mocks.findRegionById,
}));

function makeRegion(id: string, code: string): Region {
  return {
    id,
    code,
    name: code,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as Region;
}

function makeUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: "user-1",
    email: "admin@example.com",
    username: "admin",
    role: "REGION_ADMIN",
    regionId: "region-chennai",
    region_id: "region-chennai",
    mustChangePassword: false,
    accessibleSections: null,
    ...overrides,
  };
}

function makeSpecial(
  overrides: Partial<SpecialAccessPrincipal> = {},
): SpecialAccessPrincipal {
  return {
    id: "sa-1",
    username: "dual-region",
    roleId: null,
    roleName: null,
    sections: ["closed-calls"],
    allRegions: false,
    regions: ["region-chennai", "region-kanchipuram"],
    dataScope: "overall",
    permissionLevel: "view",
    ...overrides,
  };
}

/** Minimal Request stand-in — only the principal fields are read. */
function makeRequest(parts: Partial<Request>): Request {
  return parts as Request;
}

describe("allowedAspCodesForRequest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findRegionById.mockImplementation(async (id: string) => {
      const byId: Record<string, Region> = {
        "region-chennai": makeRegion("region-chennai", "CHN"),
        "region-kanchipuram": makeRegion("region-kanchipuram", "KAN"),
        "region-salem": makeRegion("region-salem", "SLM"),
      };
      return byId[id] ?? null;
    });
  });

  it("leaves a SUPER_ADMIN unrestricted", async () => {
    const allowed = await allowedAspCodesForRequest(
      makeRequest({ currentUser: makeUser({ role: "SUPER_ADMIN" }) }),
    );
    expect(allowed).toBeNull();
  });

  it("restricts a REGION_ADMIN to its own region's ASP codes", async () => {
    const allowed = await allowedAspCodesForRequest(
      makeRequest({ currentUser: makeUser() }),
    );
    expect(allowed).not.toBeNull();
    expect(allowed?.has("CHN")).toBe(true);
    expect(allowed?.has("SLM")).toBe(false);
  });

  it("gives a multi-region special-access credential the union of its regions", async () => {
    const allowed = await allowedAspCodesForRequest(
      makeRequest({ specialAccess: makeSpecial() }),
    );
    expect(allowed?.has("CHN")).toBe(true);
    expect(allowed?.has("KAN")).toBe(true);
    // The whole point: a Chennai+Kanchipuram credential must not reach Salem.
    expect(allowed?.has("SLM")).toBe(false);
  });

  it("leaves an allRegions special-access credential unrestricted", async () => {
    const allowed = await allowedAspCodesForRequest(
      makeRequest({ specialAccess: makeSpecial({ allRegions: true, regions: [] }) }),
    );
    expect(allowed).toBeNull();
  });

  it("grants a vendor-access principal no region-scoped data", async () => {
    const allowed = await allowedAspCodesForRequest(
      makeRequest({
        vendorAccess: {
          id: "v-1",
          username: "vendor",
          sections: [],
          permissionLevel: "view",
        },
      }),
    );
    expect(allowed).not.toBeNull();
    expect(allowed?.size).toBe(0);
  });

  it("grants a region admin with no region assigned nothing, rather than everything", async () => {
    const allowed = await allowedAspCodesForRequest(
      makeRequest({ currentUser: makeUser({ regionId: null, region_id: null }) }),
    );
    expect(allowed).not.toBeNull();
    expect(allowed?.size).toBe(0);
  });
});

describe("aspScopeToArray", () => {
  it("passes null through so unrestricted stays a no-op filter", () => {
    expect(aspScopeToArray(null)).toBeNull();
  });

  it("returns a sorted array for a restricted scope", () => {
    expect(aspScopeToArray(new Set(["KAN", "CHN"]))).toEqual(["CHN", "KAN"]);
  });

  it("returns an empty array (not null) for an empty scope", () => {
    // An empty array must NOT collapse to null downstream, or "no access" would
    // silently become "unrestricted access".
    expect(aspScopeToArray(new Set())).toEqual([]);
  });
});
