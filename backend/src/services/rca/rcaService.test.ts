import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RcaOpenCaseDb } from "../../repositories/rcaCaseRepository.js";
import type { Region } from "../../repositories/regionRepository.js";
import type { AuthenticatedUser } from "../../types/auth.js";
import { listRcaCases } from "./rcaService.js";

/**
 * listRcaCases over mocked repository rows: result shape, region scoping, stale
 * filtering, ordering and limits. These prove the service logic only — the rows here are
 * hand-written, not produced by the SQL.
 */

const mocks = vi.hoisted(() => ({
  listOpenRcaCases: vi.fn(),
  findRegionById: vi.fn(),
}));

vi.mock("../../repositories/rcaCaseRepository.js", () => ({
  DEFAULT_RCA_RECENCY_DAYS: 7,
  listOpenRcaCases: mocks.listOpenRcaCases,
  getRcaCaseTimeline: vi.fn(),
}));

vi.mock("../../repositories/regionRepository.js", () => ({
  findRegionById: mocks.findRegionById,
  listRegions: vi.fn(),
}));

const HOSUR: Region = { id: "11111111-1111-4111-8111-111111111111", code: "HOS", name: "HOSUR", isActive: true, createdAt: "" };
const CHENNAI: Region = { id: "22222222-2222-4222-8222-222222222222", code: "CHN", name: "CHENNAI", isActive: true, createdAt: "" };

function user(overrides: Partial<AuthenticatedUser>): AuthenticatedUser {
  return {
    id: "u1",
    email: "u1@example.com",
    username: "u1",
    role: "SUPER_ADMIN",
    regionId: null,
    region_id: null,
    mustChangePassword: false,
    accessibleSections: null,
    ...overrides,
  };
}

const REPORT_DATE = "2026-10-16";

function caseRow(ticket: string, lastActionDay: string | null, firstSeen = "2026-10-01", overrides: Partial<RcaOpenCaseDb> = {}): RcaOpenCaseDb {
  return {
    row_id: `row-${ticket}`,
    ticket_id: ticket,
    ticket_key: ticket.toUpperCase(),
    case_id: `C-${ticket}`,
    customer_name: "Customer",
    account_name: null,
    customer_mail: null,
    contact: null,
    work_location: "ASPS01511",
    engineer: "Eng",
    rtpl_status: "Part Pending",
    segment: null,
    location: null,
    product: null,
    remarks: null,
    manual_notes: null,
    rca: null,
    case_created_time: null,
    row_updated_at: null,
    row_updated_by: null,
    carried_forward_fields: [],
    manual_fields_completed: false,
    match_status: "MATCHED",
    report_id: "r1",
    report_date: REPORT_DATE,
    report_region_id: HOSUR.id,
    report_region_name: "HOSUR",
    report_region_code: "HOS",
    // Whole UTC days, so a fixture's day count is exact (see the time-of-day test below).
    last_action_at: lastActionDay ? `${lastActionDay}T00:00:00Z` : null,
    last_action_user_id: null,
    last_action_username: null,
    last_action_email: null,
    first_seen_date: firstSeen,
    total_appearances: 3,
    total_actions: 2,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.listOpenRcaCases.mockReset().mockResolvedValue([]);
  mocks.findRegionById.mockReset().mockImplementation(async (id: string) => [HOSUR, CHENNAI].find((r) => r.id === id) ?? null);
});

describe("listRcaCases — result shape and severity", () => {
  it("maps a row into the summary shape with days, severity and canonical region", async () => {
    mocks.listOpenRcaCases.mockResolvedValue([caseRow("WO-1", "2026-10-09")]);
    const result = await listRcaCases(user({}), {});
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      ticketId: "WO-1",
      ticketKey: "WO-1",
      caseId: "C-WO-1",
      regionName: "Hosur",
      regionCode: "ASPS01511",
      latestReportDate: REPORT_DATE,
      daysOpen: 15,
      daysSinceLastAction: 7,
      severity: "critical",
      isStale: true,
      totalAppearances: 3,
      totalActions: 2,
    });
  });

  it("grades severity at 2 (warn) and 5 (critical) days since the last action", async () => {
    mocks.listOpenRcaCases.mockResolvedValue([
      caseRow("WO-OK", "2026-10-15"),
      caseRow("WO-WARN2", "2026-10-14"),
      caseRow("WO-WARN4", "2026-10-12"),
      caseRow("WO-CRIT5", "2026-10-11"),
    ]);
    const { rows } = await listRcaCases(user({}), {});
    const severity = Object.fromEntries(rows.map((r) => [r.ticketId, r.severity]));
    expect(severity).toEqual({ "WO-OK": "ok", "WO-WARN2": "warn", "WO-WARN4": "warn", "WO-CRIT5": "critical" });
  });

  it("counts whole elapsed days from the action's timestamp (time of day matters)", async () => {
    // Pins existing behaviour: days are floor(elapsed / 24h) against the report date's
    // midnight UTC, so an action at 10:00 IST five calendar days earlier counts as 4.
    mocks.listOpenRcaCases.mockResolvedValue([
      caseRow("WO-IST", null, "2026-10-01", { last_action_at: "2026-10-11T10:00:00+05:30" }),
    ]);
    const { rows } = await listRcaCases(user({}), {});
    expect(rows[0]).toMatchObject({ daysSinceLastAction: 4, severity: "warn" });
  });

  it("falls back to days open when a case has never been acted on", async () => {
    mocks.listOpenRcaCases.mockResolvedValue([caseRow("WO-NEW", null, "2026-10-13")]);
    const { rows } = await listRcaCases(user({}), {});
    expect(rows[0]).toMatchObject({ daysOpen: 3, daysSinceLastAction: 3, severity: "warn" });
  });

  it("summarises the whole open set: totals, averages, latest report, regions covered", async () => {
    mocks.listOpenRcaCases.mockResolvedValue([
      caseRow("WO-A", "2026-10-16"),
      caseRow("WO-B", "2026-10-13"),
      caseRow("WO-C", "2026-10-06", "2026-10-01", { work_location: "ASPS01461", report_region_name: "CHENNAI" }),
    ]);
    const { summary } = await listRcaCases(user({}), {});
    expect(summary).toMatchObject({
      latestReportDate: REPORT_DATE,
      totalOpen: 3,
      totalStale: 2,
      totalCritical: 1,
      avgDaysSinceLastAction: 4.3,
      avgDaysOpen: 15,
      staleThresholdDays: 2,
      criticalThresholdDays: 5,
      recencyWindowDays: 7,
      regionsCovered: 2,
    });
  });
});

describe("listRcaCases — region scoping", () => {
  it("SUPER_ADMIN without a region reads every region (no work-location scope)", async () => {
    await listRcaCases(user({}), { search: "acme" });
    expect(mocks.listOpenRcaCases).toHaveBeenCalledWith({ workLocations: null, search: "acme", recencyDays: 7 });
  });

  it("SUPER_ADMIN choosing a region is scoped to that region's ASP codes", async () => {
    await listRcaCases(user({}), { regionId: HOSUR.id });
    const scope = mocks.listOpenRcaCases.mock.calls[0]![0].workLocations as string[];
    expect(scope).toContain("ASPS01511");
    expect(scope).not.toContain("ASPS01461");
  });

  it("REGION_ADMIN is always scoped to its own region", async () => {
    await listRcaCases(user({ role: "REGION_ADMIN", regionId: HOSUR.id, region_id: HOSUR.id }), {});
    const scope = mocks.listOpenRcaCases.mock.calls[0]![0].workLocations as string[];
    expect(scope).toContain("ASPS01511");
    expect(scope).not.toContain("ASPS01461");
  });

  it("REGION_ADMIN asking for another region is refused before any query runs", async () => {
    await expect(
      listRcaCases(user({ role: "REGION_ADMIN", regionId: HOSUR.id, region_id: HOSUR.id }), { regionId: CHENNAI.id }),
    ).rejects.toThrow(/another region/);
    expect(mocks.listOpenRcaCases).not.toHaveBeenCalled();
  });

  it("REGION_ADMIN with no region assigned is refused", async () => {
    await expect(listRcaCases(user({ role: "REGION_ADMIN" }), {})).rejects.toThrow(/not assigned to a region/);
    expect(mocks.listOpenRcaCases).not.toHaveBeenCalled();
  });
});

describe("listRcaCases — stale filtering, ordering and limits", () => {
  const rows = () => [
    caseRow("WO-OK", "2026-10-16"),
    caseRow("WO-WARN", "2026-10-13"),
    caseRow("WO-CRIT-B", "2026-10-06", "2026-10-01"),
    caseRow("WO-CRIT-A", "2026-10-06", "2026-10-01"),
    caseRow("WO-CRIT-OLDER", "2026-10-06", "2026-09-20"),
  ];

  it("filters by status without changing the summary totals", async () => {
    for (const [status, expected] of [
      ["all", 5],
      ["stale", 4],
      ["critical", 3],
      ["active", 1],
    ] as const) {
      mocks.listOpenRcaCases.mockResolvedValue(rows());
      const result = await listRcaCases(user({}), { status });
      expect(result.total).toBe(expected);
      expect(result.summary.totalOpen).toBe(5);
      expect(result.staleCount).toBe(4);
      expect(result.criticalCount).toBe(3);
    }
  });

  it("orders by days since last action, then days open, then ticket id", async () => {
    mocks.listOpenRcaCases.mockResolvedValue(rows());
    const { rows: ordered } = await listRcaCases(user({}), {});
    expect(ordered.map((r) => r.ticketId)).toEqual(["WO-CRIT-OLDER", "WO-CRIT-A", "WO-CRIT-B", "WO-WARN", "WO-OK"]);
  });

  it("paginates with a default of 100, clamped to 1..500, offset never negative", async () => {
    const many = Array.from({ length: 600 }, (_, i) => caseRow(`WO-${String(i).padStart(3, "0")}`, "2026-10-06"));
    mocks.listOpenRcaCases.mockResolvedValue(many);
    expect((await listRcaCases(user({}), {})).rows).toHaveLength(100);

    mocks.listOpenRcaCases.mockResolvedValue(many);
    expect((await listRcaCases(user({}), { limit: 9999 })).rows).toHaveLength(500);

    mocks.listOpenRcaCases.mockResolvedValue(many);
    expect((await listRcaCases(user({}), { limit: 0 })).rows).toHaveLength(1);

    mocks.listOpenRcaCases.mockResolvedValue(many);
    const page = await listRcaCases(user({}), { limit: 2, offset: 598 });
    expect(page.rows.map((r) => r.ticketId)).toEqual(["WO-598", "WO-599"]);
    expect(page.total).toBe(600);

    mocks.listOpenRcaCases.mockResolvedValue(many);
    expect((await listRcaCases(user({}), { limit: 1, offset: -5 })).rows[0]!.ticketId).toBe("WO-000");
  });
});
