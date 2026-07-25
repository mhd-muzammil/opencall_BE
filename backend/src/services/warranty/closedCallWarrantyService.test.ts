import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WarrantyCacheEntry } from "../../repositories/warrantyCacheRepository.js";
import type { ClosedCallRow } from "../../repositories/closedCallWarrantyRepository.js";
import {
  getClosedCallWarrantyList,
  getClosedCallWarrantyStatuses,
} from "./closedCallWarrantyService.js";

// Real serial helpers (normalizeSerial / isNoSerialValue) run unmocked so the
// classification is exercised end-to-end; only the DB repositories are stubbed.
const mocks = vi.hoisted(() => ({
  warrantyTablesPresent: vi.fn(),
  getLatestReportClosedCalls: vi.fn(),
  getLatestReportClosedSerials: vi.fn(),
  findQueuedSerials: vi.fn(),
  getOrCreateClosedCallsJobId: vi.fn(),
  countEnqueuedTodayForJob: vi.fn(),
  findCachedWarranties: vi.fn(),
  insertWarrantyJobItems: vi.fn(),
}));

vi.mock("../../repositories/closedCallWarrantyRepository.js", () => ({
  warrantyTablesPresent: mocks.warrantyTablesPresent,
  getLatestReportClosedCalls: mocks.getLatestReportClosedCalls,
  getLatestReportClosedSerials: mocks.getLatestReportClosedSerials,
  findQueuedSerials: mocks.findQueuedSerials,
  getOrCreateClosedCallsJobId: mocks.getOrCreateClosedCallsJobId,
  countEnqueuedTodayForJob: mocks.countEnqueuedTodayForJob,
}));

vi.mock("../../repositories/warrantyCacheRepository.js", () => ({
  findCachedWarranties: mocks.findCachedWarranties,
}));

vi.mock("../../repositories/warrantyJobItemRepository.js", () => ({
  // Echo the enqueued count, like the real INSERT ... RETURNING would.
  insertWarrantyJobItems: mocks.insertWarrantyJobItems,
}));

const JOB_ID = "00000000-0000-4000-8000-000000000001";
const FUTURE = "2999-12-31"; // always >= today
const PAST = "2000-01-01"; // always < today

function cacheHit(overrides: Partial<WarrantyCacheEntry> = {}): WarrantyCacheEntry {
  return {
    serial: "SER",
    lookupStatus: "OK",
    startDate: null,
    endDate: FUTURE,
    productNumber: null,
    hpStatus: "Active",
    fetchedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function closedCall(overrides: Partial<ClosedCallRow> = {}): ClosedCallRow {
  return {
    ticketId: "WO-1",
    customer: "Acme",
    serial: "SER1",
    region: "SALEM",
    model: "LaserJet",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.warrantyTablesPresent.mockResolvedValue(true);
  mocks.getOrCreateClosedCallsJobId.mockResolvedValue(JOB_ID);
  mocks.countEnqueuedTodayForJob.mockResolvedValue(0);
  mocks.findQueuedSerials.mockResolvedValue([]);
  mocks.findCachedWarranties.mockResolvedValue([]);
  // Default: enqueue succeeds for every item handed in.
  mocks.insertWarrantyJobItems.mockImplementation(
    async (items: readonly unknown[]) => items.length,
  );
});

describe("getClosedCallWarrantyList — status derivation", () => {
  it("returns available:false without touching the DB when tables are absent", async () => {
    mocks.warrantyTablesPresent.mockResolvedValue(false);

    const res = await getClosedCallWarrantyList();

    expect(res).toEqual({ rows: [], enqueued: 0, dailyRemaining: 0, available: false });
    expect(mocks.getLatestReportClosedCalls).not.toHaveBeenCalled();
  });

  it("maps a cache hit with a future end date to IN_WARRANTY and passes dates through", async () => {
    mocks.getLatestReportClosedCalls.mockResolvedValue([closedCall({ serial: "sn-1" })]);
    mocks.findCachedWarranties.mockResolvedValue([
      cacheHit({ serial: "SN-1", startDate: "2023-01-06", endDate: FUTURE, hpStatus: "Active" }),
    ]);

    const { rows } = await getClosedCallWarrantyList();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "IN_WARRANTY",
      startDate: "2023-01-06",
      endDate: FUTURE,
      hpStatus: "Active",
      serial: "sn-1", // original casing preserved for display
    });
  });

  it("maps a cache hit with a past end date to OUT_OF_WARRANTY", async () => {
    mocks.getLatestReportClosedCalls.mockResolvedValue([closedCall({ serial: "sn-2" })]);
    mocks.findCachedWarranties.mockResolvedValue([
      cacheHit({ serial: "SN-2", endDate: PAST, hpStatus: "Expired" }),
    ]);

    const { rows } = await getClosedCallWarrantyList();
    expect(rows[0]?.status).toBe("OUT_OF_WARRANTY");
  });

  it("maps a NOT_FOUND cache hit to NOT_FOUND", async () => {
    mocks.getLatestReportClosedCalls.mockResolvedValue([closedCall({ serial: "sn-3" })]);
    mocks.findCachedWarranties.mockResolvedValue([
      cacheHit({ serial: "SN-3", lookupStatus: "NOT_FOUND", endDate: null, hpStatus: null }),
    ]);

    const { rows } = await getClosedCallWarrantyList();
    expect(rows[0]?.status).toBe("NOT_FOUND");
  });

  it("falls back to HP status word when OK but no end date parsed", async () => {
    mocks.getLatestReportClosedCalls.mockResolvedValue([
      closedCall({ ticketId: "WO-A", serial: "sn-active" }),
      closedCall({ ticketId: "WO-B", serial: "sn-expired" }),
    ]);
    mocks.findCachedWarranties.mockResolvedValue([
      cacheHit({ serial: "SN-ACTIVE", endDate: null, hpStatus: "Active" }),
      cacheHit({ serial: "SN-EXPIRED", endDate: null, hpStatus: "Expired" }),
    ]);

    const { rows } = await getClosedCallWarrantyList();
    const byTicket = Object.fromEntries(rows.map((r) => [r.ticketId, r.status]));
    expect(byTicket["WO-A"]).toBe("IN_WARRANTY");
    expect(byTicket["WO-B"]).toBe("OUT_OF_WARRANTY");
  });

  it("classifies blank and NOSN serials as NO_SERIAL without enqueuing them", async () => {
    mocks.getLatestReportClosedCalls.mockResolvedValue([
      closedCall({ ticketId: "WO-BLANK", serial: "" }),
      closedCall({ ticketId: "WO-NOSN", serial: "A9T81B NOSN" }),
    ]);

    const { rows } = await getClosedCallWarrantyList();

    expect(rows.map((r) => r.status)).toEqual(["NO_SERIAL", "NO_SERIAL"]);
    expect(mocks.insertWarrantyJobItems).not.toHaveBeenCalled();
  });

  it("marks an in-flight (queued) serial CHECKING and does not re-enqueue it", async () => {
    mocks.getLatestReportClosedCalls.mockResolvedValue([closedCall({ serial: "sn-q" })]);
    mocks.findQueuedSerials.mockResolvedValue(["SN-Q"]);

    const { rows, enqueued } = await getClosedCallWarrantyList();

    expect(rows[0]?.status).toBe("CHECKING");
    expect(enqueued).toBe(0);
    expect(mocks.insertWarrantyJobItems).not.toHaveBeenCalled();
  });

  it("enqueues an uncached serial once and shows it as CHECKING (now in-flight)", async () => {
    mocks.getLatestReportClosedCalls.mockResolvedValue([closedCall({ serial: "sn-new" })]);

    const { rows, enqueued } = await getClosedCallWarrantyList();

    // Enqueued this request → it is queued now, so it reads CHECKING, not NOT_CHECKED.
    expect(rows[0]?.status).toBe("CHECKING");
    expect(enqueued).toBe(1);
    const enqueuedSerials = mocks.insertWarrantyJobItems.mock.calls[0]?.[0] as Array<{ serial: string }>;
    expect(enqueuedSerials.map((i) => i.serial)).toEqual(["SN-NEW"]);
  });

  it("dedupes the same serial across two closed calls: looked up once, enqueued once", async () => {
    mocks.getLatestReportClosedCalls.mockResolvedValue([
      closedCall({ ticketId: "WO-1", serial: "dup" }),
      closedCall({ ticketId: "WO-2", serial: "DUP" }), // same normalized serial
    ]);

    const { rows, enqueued } = await getClosedCallWarrantyList();

    expect(mocks.findCachedWarranties).toHaveBeenCalledWith(["DUP"]);
    expect(enqueued).toBe(1); // deduped: one HP lookup enqueued, not two
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "CHECKING")).toBe(true);
  });

  it("respects the ~100/day cap: over-budget serials stay NOT_CHECKED", async () => {
    // 98 already enqueued today → only 2 of the 5 new serials may go; the rest
    // are left un-enqueued and therefore render as NOT_CHECKED.
    mocks.countEnqueuedTodayForJob.mockResolvedValue(98);
    mocks.getLatestReportClosedCalls.mockResolvedValue(
      ["s1", "s2", "s3", "s4", "s5"].map((s, i) =>
        closedCall({ ticketId: `WO-${i}`, serial: s }),
      ),
    );

    const { rows, enqueued, dailyRemaining } = await getClosedCallWarrantyList();

    expect(enqueued).toBe(2);
    expect(dailyRemaining).toBe(0);
    const sent = mocks.insertWarrantyJobItems.mock.calls[0]?.[0] as unknown[];
    expect(sent).toHaveLength(2);
    const counts = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ CHECKING: 2, NOT_CHECKED: 3 });
  });
});

describe("getClosedCallWarrantyStatuses — keyed by supplied serial", () => {
  it("returns available:false when tables are absent", async () => {
    mocks.warrantyTablesPresent.mockResolvedValue(false);
    const res = await getClosedCallWarrantyStatuses(["ABC"]);
    expect(res).toEqual({ entries: [], enqueued: 0, dailyRemaining: 0, available: false });
  });

  it("keys each entry by the raw serial and classifies NO_SERIAL / cache hit / uncached", async () => {
    mocks.findCachedWarranties.mockResolvedValue([
      cacheHit({ serial: "GOOD", endDate: FUTURE }),
    ]);

    const res = await getClosedCallWarrantyStatuses(["good", "", "fresh"]);

    const byRaw = Object.fromEntries(res.entries.map((e) => [e.serial, e.status]));
    expect(byRaw["good"]).toBe("IN_WARRANTY"); // normalized to GOOD, cache hit
    expect(byRaw[""]).toBe("NO_SERIAL");
    expect(byRaw["fresh"]).toBe("CHECKING"); // uncached → enqueued now → in-flight
    expect(res.enqueued).toBe(1); // only the one lookupable+uncached serial
  });
});
