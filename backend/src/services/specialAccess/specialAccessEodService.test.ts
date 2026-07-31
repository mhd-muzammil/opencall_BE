import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecialAccessPrincipal } from "../../types/auth.js";

const mocks = vi.hoisted(() => ({
  findRegionById: vi.fn(),
  freezeRegionDay: vi.fn(),
  getRegionEodState: vi.fn(),
}));

vi.mock("../../repositories/regionRepository.js", () => ({
  findRegionById: mocks.findRegionById,
}));

vi.mock("../productivity/eodService.js", () => ({
  freezeRegionDay: mocks.freezeRegionDay,
  getRegionEodState: mocks.getRegionEodState,
}));

const {
  closeRegionEodForSpecialAccess,
  getRegionEodStateForSpecialAccess,
} = await import("./specialAccessEodService.js");

const CHENNAI = "11111111-1111-1111-1111-111111111111";
const KANCHIPURAM = "22222222-2222-2222-2222-222222222222";
const SALEM = "33333333-3333-3333-3333-333333333333";

function principal(
  overrides: Partial<SpecialAccessPrincipal> = {},
): SpecialAccessPrincipal {
  return {
    id: "sa-1",
    username: "dual.region",
    roleId: null,
    roleName: null,
    sections: ["productivity", "records"],
    allRegions: false,
    regions: [CHENNAI, KANCHIPURAM],
    dataScope: "overall",
    permissionLevel: "edit",
    ...overrides,
  };
}

function eodState() {
  return {
    workingDate: "2026-07-31",
    regions: [
      { regionId: CHENNAI, regionName: "Chennai", status: "OPEN" },
      { regionId: KANCHIPURAM, regionName: "Kanchipuram", status: "OPEN" },
      { regionId: SALEM, regionName: "Salem", status: "CLOSED" },
    ],
  };
}

describe("closeRegionEodForSpecialAccess", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findRegionById.mockImplementation(async (id: string) => ({
      id,
      code: "CHN",
      name: "Chennai",
    }));
    mocks.freezeRegionDay.mockResolvedValue({
      state: { id: "eod-1" },
      snapshot: { list: [], totalAttended: 0 },
      frozenNow: true,
    });
  });

  it("freezes a granted region for an edit credential", async () => {
    const result = await closeRegionEodForSpecialAccess(
      principal(),
      CHENNAI,
      "2026-07-31",
    );

    expect(result.frozenNow).toBe(true);
    // closedBy MUST be null: a special-access credential is not a `users` row and
    // region_eod_state.closed_by is an FK to users(id).
    expect(mocks.freezeRegionDay).toHaveBeenCalledWith(
      expect.objectContaining({ id: CHENNAI }),
      "2026-07-31",
      null,
    );
  });

  it("freezes the credential's OTHER granted region too", async () => {
    await closeRegionEodForSpecialAccess(principal(), KANCHIPURAM, "2026-07-31");
    expect(mocks.freezeRegionDay).toHaveBeenCalledOnce();
  });

  it("refuses a region the credential was not granted", async () => {
    await expect(
      closeRegionEodForSpecialAccess(principal(), SALEM, "2026-07-31"),
    ).rejects.toThrow(/not granted/i);
    expect(mocks.freezeRegionDay).not.toHaveBeenCalled();
  });

  it("refuses a view-only credential", async () => {
    await expect(
      closeRegionEodForSpecialAccess(
        principal({ permissionLevel: "view" }),
        CHENNAI,
        "2026-07-31",
      ),
    ).rejects.toThrow(/view-only/i);
    expect(mocks.freezeRegionDay).not.toHaveBeenCalled();
  });

  it("refuses a credential without the productivity section", async () => {
    await expect(
      closeRegionEodForSpecialAccess(
        principal({ sections: ["records"] }),
        CHENNAI,
        "2026-07-31",
      ),
    ).rejects.toThrow(/productivity/i);
    expect(mocks.freezeRegionDay).not.toHaveBeenCalled();
  });

  it("allows any region for an allRegions credential", async () => {
    await closeRegionEodForSpecialAccess(
      principal({ allRegions: true, regions: [] }),
      SALEM,
      "2026-07-31",
    );
    expect(mocks.freezeRegionDay).toHaveBeenCalledOnce();
  });

  it("rejects a region that does not exist", async () => {
    mocks.findRegionById.mockResolvedValue(null);
    await expect(
      closeRegionEodForSpecialAccess(principal(), CHENNAI, "2026-07-31"),
    ).rejects.toThrow(/not found/i);
  });
});

describe("getRegionEodStateForSpecialAccess", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getRegionEodState.mockResolvedValue(eodState());
  });

  it("returns only the credential's granted regions", async () => {
    const state = await getRegionEodStateForSpecialAccess(
      principal(),
      "2026-07-31",
    );

    expect(state.regions.map((r) => r.regionId)).toEqual([CHENNAI, KANCHIPURAM]);
    // Salem is another region's day — it must not leak into a scoped credential.
    expect(state.regions.some((r) => r.regionId === SALEM)).toBe(false);
  });

  it("returns every region for an allRegions credential", async () => {
    const state = await getRegionEodStateForSpecialAccess(
      principal({ allRegions: true, regions: [] }),
      "2026-07-31",
    );

    expect(state.regions).toHaveLength(3);
  });
});
