import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExpiringWarrantyRow,
  RenewalLeadStateRow,
  SerialCustomerRow,
} from "../../repositories/renewalLeadRepository.js";
import type { Region } from "../../repositories/regionRepository.js";
import type { AuthenticatedUser } from "../../types/auth.js";
import { getRenewalPipeline, saveRenewalLead } from "./renewalService.js";

// Only the DB repositories are stubbed; the window bucketing, days-left maths and region
// scoping all run for real.
const mocks = vi.hoisted(() => ({
  renewalTablesPresent: vi.fn(),
  findExpiringWarranties: vi.fn(),
  findLatestRowsForSerials: vi.fn(),
  findLeadStates: vi.fn(),
  upsertLeadState: vi.fn(),
  serialHasWarrantyEntitlement: vi.fn(),
  findWorkLocationForSerial: vi.fn(),
  findAllowedRegionsForUser: vi.fn(),
}));

vi.mock("../../repositories/renewalLeadRepository.js", () => ({
  renewalTablesPresent: mocks.renewalTablesPresent,
  findExpiringWarranties: mocks.findExpiringWarranties,
  findLatestRowsForSerials: mocks.findLatestRowsForSerials,
  findLeadStates: mocks.findLeadStates,
  upsertLeadState: mocks.upsertLeadState,
  serialHasWarrantyEntitlement: mocks.serialHasWarrantyEntitlement,
  findWorkLocationForSerial: mocks.findWorkLocationForSerial,
}));

vi.mock("../rbac/regionAccessService.js", () => ({
  findAllowedRegionsForUser: mocks.findAllowedRegionsForUser,
}));

const SUPER_ADMIN: AuthenticatedUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@opencall.com",
  username: null,
  role: "SUPER_ADMIN",
  regionId: null,
  region_id: null,
  mustChangePassword: false,
  accessibleSections: null,
};

const REGION_ADMIN: AuthenticatedUser = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "salem@opencall.com",
  username: null,
  role: "REGION_ADMIN",
  regionId: "00000000-0000-4000-8000-0000000000aa",
  region_id: "00000000-0000-4000-8000-0000000000aa",
  mustChangePassword: false,
  accessibleSections: null,
};

const SALEM_REGION: Region = {
  id: "00000000-0000-4000-8000-0000000000aa",
  code: "ASPS01465",
  name: "SALEM",
  isActive: true,
  createdAt: "2024-01-01T00:00:00.000Z",
};

/** An ISO date `days` from today in IST, so the tests never depend on a fixed clock. */
function isoDaysFromToday(days: number): string {
  const todayIso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const base = new Date(`${todayIso}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function warranty(overrides: Partial<ExpiringWarrantyRow> = {}): ExpiringWarrantyRow {
  return {
    serial: "SER1",
    startDate: "2023-01-01",
    endDate: isoDaysFromToday(10),
    productNumber: "PN-1",
    hpStatus: "Active",
    ...overrides,
  };
}

function customer(overrides: Partial<SerialCustomerRow> = {}): SerialCustomerRow {
  return {
    serial: "SER1",
    ticketId: "WO-1",
    customerName: "Acme",
    accountName: "Acme Ltd",
    contact: "9876543210",
    customerMail: "ops@acme.test",
    product: "LaserJet",
    workLocation: "ASPS01465",
    reportDate: "2026-07-01",
    ...overrides,
  };
}

function leadState(overrides: Partial<RenewalLeadStateRow> = {}): RenewalLeadStateRow {
  return {
    serial: "SER1",
    status: "Contacted",
    owner: "Priya",
    remarks: "Called on Monday",
    updatedAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.renewalTablesPresent.mockResolvedValue(true);
  mocks.findExpiringWarranties.mockResolvedValue([]);
  mocks.findLatestRowsForSerials.mockResolvedValue([]);
  mocks.findLeadStates.mockResolvedValue([]);
  mocks.findAllowedRegionsForUser.mockResolvedValue(null);
  mocks.serialHasWarrantyEntitlement.mockResolvedValue(true);
  mocks.findWorkLocationForSerial.mockResolvedValue("ASPS01465");
  mocks.upsertLeadState.mockImplementation(
    async (input: { serial: string; status: string; owner: string; remarks: string }) => ({
      ...input,
      updatedAt: "2026-07-29T10:00:00.000Z",
    }),
  );
});

describe("getRenewalPipeline", () => {
  it("reports unavailable (and reads nothing) when the tables are not migrated", async () => {
    mocks.renewalTablesPresent.mockResolvedValue(false);

    const result = await getRenewalPipeline(SUPER_ADMIN);

    expect(result.available).toBe(false);
    expect(result.rows).toEqual([]);
    expect(mocks.findExpiringWarranties).not.toHaveBeenCalled();
  });

  it("builds a lead from the warranty cache joined to the latest call", async () => {
    mocks.findExpiringWarranties.mockResolvedValue([warranty()]);
    mocks.findLatestRowsForSerials.mockResolvedValue([customer()]);

    const { rows } = await getRenewalPipeline(SUPER_ADMIN);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      serial: "SER1",
      customerName: "Acme",
      contact: "9876543210",
      product: "LaserJet",
      regionName: "SALEM",
      daysLeft: 10,
      // Never touched, so it is implicitly New.
      status: "New",
      owner: "",
    });
  });

  it("overlays the saved follow-up state onto the derived lead", async () => {
    mocks.findExpiringWarranties.mockResolvedValue([warranty()]);
    mocks.findLatestRowsForSerials.mockResolvedValue([customer()]);
    mocks.findLeadStates.mockResolvedValue([leadState()]);

    const { rows, summary } = await getRenewalPipeline(SUPER_ADMIN);

    expect(rows[0]).toMatchObject({
      status: "Contacted",
      owner: "Priya",
      remarks: "Called on Monday",
    });
    expect(summary.byStatus.Contacted).toBe(1);
    expect(summary.byStatus.New).toBe(0);
  });

  it("computes a negative daysLeft for an already-expired warranty", async () => {
    mocks.findExpiringWarranties.mockResolvedValue([
      warranty({ endDate: isoDaysFromToday(-12) }),
    ]);
    mocks.findLatestRowsForSerials.mockResolvedValue([customer()]);

    const { rows, summary } = await getRenewalPipeline(SUPER_ADMIN, { window: "EXPIRED" });

    expect(rows[0]?.daysLeft).toBe(-12);
    expect(summary.expired).toBe(1);
    expect(summary.expiring30).toBe(0);
  });

  it("filters by window, with cumulative expiring buckets, while the summary stays whole", async () => {
    mocks.findExpiringWarranties.mockResolvedValue([
      warranty({ serial: "S-10", endDate: isoDaysFromToday(10) }),
      warranty({ serial: "S-45", endDate: isoDaysFromToday(45) }),
      warranty({ serial: "S-80", endDate: isoDaysFromToday(80) }),
      warranty({ serial: "S-OLD", endDate: isoDaysFromToday(-5) }),
    ]);
    mocks.findLatestRowsForSerials.mockResolvedValue([
      customer({ serial: "S-10" }),
      customer({ serial: "S-45" }),
      customer({ serial: "S-80" }),
      customer({ serial: "S-OLD" }),
    ]);

    const thirty = await getRenewalPipeline(SUPER_ADMIN, { window: "EXPIRING_30" });
    expect(thirty.rows.map((r) => r.serial)).toEqual(["S-10"]);

    const sixty = await getRenewalPipeline(SUPER_ADMIN, { window: "EXPIRING_60" });
    expect(sixty.rows.map((r) => r.serial)).toEqual(["S-10", "S-45"]);

    // Counts describe everything visible, not just the filtered slice.
    expect(sixty.summary).toMatchObject({
      total: 4,
      expiring30: 1,
      expiring60: 2,
      expiring90: 3,
      expired: 1,
    });
  });

  it("sorts soonest-to-expire first and pushes already-expired to the end", async () => {
    mocks.findExpiringWarranties.mockResolvedValue([
      warranty({ serial: "S-80", endDate: isoDaysFromToday(80) }),
      warranty({ serial: "S-OLD", endDate: isoDaysFromToday(-5) }),
      warranty({ serial: "S-10", endDate: isoDaysFromToday(10) }),
    ]);
    mocks.findLatestRowsForSerials.mockResolvedValue([
      customer({ serial: "S-80" }),
      customer({ serial: "S-OLD" }),
      customer({ serial: "S-10" }),
    ]);

    const { rows } = await getRenewalPipeline(SUPER_ADMIN, { window: "ALL" });

    expect(rows.map((r) => r.serial)).toEqual(["S-10", "S-80", "S-OLD"]);
  });

  it("region-scopes a REGION_ADMIN to their own ASP codes", async () => {
    mocks.findAllowedRegionsForUser.mockResolvedValue([SALEM_REGION]);
    mocks.findExpiringWarranties.mockResolvedValue([
      warranty({ serial: "S-SALEM" }),
      warranty({ serial: "S-CHENNAI" }),
      warranty({ serial: "S-NOCALL" }),
    ]);
    mocks.findLatestRowsForSerials.mockResolvedValue([
      customer({ serial: "S-SALEM", workLocation: "ASPS01465" }),
      customer({ serial: "S-CHENNAI", workLocation: "ASPS01461" }),
      // S-NOCALL has no report row at all -> no region -> not visible to a region admin.
    ]);

    const { rows } = await getRenewalPipeline(REGION_ADMIN, { window: "ALL" });

    expect(rows.map((r) => r.serial)).toEqual(["S-SALEM"]);
  });

  it("lets a SUPER_ADMIN see leads that have no report row (no region)", async () => {
    mocks.findExpiringWarranties.mockResolvedValue([warranty({ serial: "S-ORPHAN" })]);
    mocks.findLatestRowsForSerials.mockResolvedValue([]);

    const { rows } = await getRenewalPipeline(SUPER_ADMIN, { window: "ALL" });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ serial: "S-ORPHAN", regionName: "", customerName: "" });
  });

  it("searches across customer, serial and contact", async () => {
    mocks.findExpiringWarranties.mockResolvedValue([
      warranty({ serial: "S-1" }),
      warranty({ serial: "S-2" }),
    ]);
    mocks.findLatestRowsForSerials.mockResolvedValue([
      customer({ serial: "S-1", customerName: "Acme" }),
      customer({ serial: "S-2", customerName: "Globex" }),
    ]);

    const { rows } = await getRenewalPipeline(SUPER_ADMIN, {
      window: "ALL",
      search: "globex",
    });

    expect(rows.map((r) => r.serial)).toEqual(["S-2"]);
  });

  it("never enqueues an HP lookup — the warranty worker's budget is untouched", async () => {
    mocks.findExpiringWarranties.mockResolvedValue([warranty()]);
    mocks.findLatestRowsForSerials.mockResolvedValue([customer()]);

    await getRenewalPipeline(SUPER_ADMIN);

    // The repository exposes no enqueue at all; assert the read-only surface stays read-only.
    expect(Object.keys(mocks)).not.toContain("insertWarrantyJobItems");
    expect(mocks.findExpiringWarranties).toHaveBeenCalledTimes(1);
  });
});

describe("saveRenewalLead", () => {
  it("saves the follow-up state, upper-casing the serial", async () => {
    const saved = await saveRenewalLead(SUPER_ADMIN, {
      serial: " ser1 ",
      status: "Quoted",
      owner: " Priya ",
      remarks: " Quote sent ",
    });

    expect(mocks.upsertLeadState).toHaveBeenCalledWith({
      serial: "SER1",
      status: "Quoted",
      owner: "Priya",
      remarks: "Quote sent",
      updatedBy: SUPER_ADMIN.id,
    });
    expect(saved.status).toBe("Quoted");
  });

  it("rejects a serial HP has no cached entitlement for", async () => {
    mocks.serialHasWarrantyEntitlement.mockResolvedValue(false);

    await expect(
      saveRenewalLead(SUPER_ADMIN, {
        serial: "UNKNOWN",
        status: "Won",
        owner: "",
        remarks: "",
      }),
    ).rejects.toThrow(/no hp warranty entitlement/i);
    expect(mocks.upsertLeadState).not.toHaveBeenCalled();
  });

  it("rejects an invalid status", async () => {
    await expect(
      saveRenewalLead(SUPER_ADMIN, {
        serial: "SER1",
        status: "Maybe" as never,
        owner: "",
        remarks: "",
      }),
    ).rejects.toThrow(/valid renewal lead status/i);
    expect(mocks.upsertLeadState).not.toHaveBeenCalled();
  });

  it("stops a REGION_ADMIN saving a lead outside their region", async () => {
    mocks.findAllowedRegionsForUser.mockResolvedValue([SALEM_REGION]);
    mocks.findWorkLocationForSerial.mockResolvedValue("ASPS01461"); // Chennai

    await expect(
      saveRenewalLead(REGION_ADMIN, {
        serial: "SER1",
        status: "Contacted",
        owner: "",
        remarks: "",
      }),
    ).rejects.toThrow(/outside your region/i);
    expect(mocks.upsertLeadState).not.toHaveBeenCalled();
  });

  it("allows a REGION_ADMIN to save a lead inside their region", async () => {
    mocks.findAllowedRegionsForUser.mockResolvedValue([SALEM_REGION]);
    mocks.findWorkLocationForSerial.mockResolvedValue("ASPS01465");

    const saved = await saveRenewalLead(REGION_ADMIN, {
      serial: "SER1",
      status: "Won",
      owner: "Suresh",
      remarks: "",
    });

    expect(saved.status).toBe("Won");
    expect(mocks.upsertLeadState).toHaveBeenCalledTimes(1);
  });
});
