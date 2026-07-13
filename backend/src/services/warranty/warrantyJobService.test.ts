import type { WarrantyJobItemCounts } from "@opencall/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../utils/httpError.js";
import type { InsertWarrantyJobItemInput } from "../../repositories/warrantyJobItemRepository.js";
import type { WarrantyJobRecord } from "../../repositories/warrantyJobRepository.js";
import {
  buildWarrantyJobFile,
  createWarrantyJob,
  deriveJobStatus,
  getWarrantyJob,
  retryWarrantyJob,
} from "./warrantyJobService.js";

const mocks = vi.hoisted(() => ({
  extractSerials: vi.fn(),
  findCachedWarranties: vi.fn(),
  insertWarrantyJob: vi.fn(),
  findWarrantyJobById: vi.fn(),
  updateWarrantyJobStatus: vi.fn(),
  insertWarrantyJobItems: vi.fn(),
  countJobItems: vi.fn(),
  listJobItems: vi.fn(),
  resetFailedItems: vi.fn(),
  writeWarrantyWorkbook: vi.fn(),
}));

vi.mock("./serialExtractor.js", () => ({
  extractSerials: mocks.extractSerials,
}));

vi.mock("./warrantyExcelWriter.js", () => ({
  writeWarrantyWorkbook: mocks.writeWarrantyWorkbook,
}));

vi.mock("../../repositories/warrantyCacheRepository.js", () => ({
  findCachedWarranties: mocks.findCachedWarranties,
}));

vi.mock("../../repositories/warrantyJobRepository.js", () => ({
  insertWarrantyJob: mocks.insertWarrantyJob,
  findWarrantyJobById: mocks.findWarrantyJobById,
  updateWarrantyJobStatus: mocks.updateWarrantyJobStatus,
}));

vi.mock("../../repositories/warrantyJobItemRepository.js", () => ({
  insertWarrantyJobItems: mocks.insertWarrantyJobItems,
  countJobItems: mocks.countJobItems,
  listJobItems: mocks.listJobItems,
  resetFailedItems: mocks.resetFailedItems,
}));

const JOB_ID = "6f1b7f0e-6d1a-4a3f-9f28-2a0f1c3b4d5e";

function jobRecord(
  overrides: Partial<WarrantyJobRecord> = {},
): WarrantyJobRecord {
  return {
    id: JOB_ID,
    originalFileName: "flex-wip.xlsx",
    storedFilePath: "/storage/uploads/flex-wip.xlsx",
    status: "pending",
    totalRows: 3,
    uniqueSerials: 3,
    createdBy: "user-1",
    regionId: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

function counts(overrides: Partial<WarrantyJobItemCounts> = {}): WarrantyJobItemCounts {
  return {
    total: 0,
    pending: 0,
    processing: 0,
    done: 0,
    failed: 0,
    ok: 0,
    notFound: 0,
    noSerial: 0,
    failedLookup: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateWarrantyJobStatus.mockImplementation(
    async (id: string, status: WarrantyJobRecord["status"]) =>
      jobRecord({ id, status }),
  );
  mocks.insertWarrantyJobItems.mockResolvedValue(0);
  mocks.resetFailedItems.mockResolvedValue(0);
});

describe("deriveJobStatus", () => {
  it("is completed once nothing is queued or in flight", () => {
    expect(deriveJobStatus(counts({ total: 5, done: 4, failed: 1 }))).toBe(
      "completed",
    );
  });

  it("is pending before the worker touches anything", () => {
    expect(deriveJobStatus(counts({ total: 5, pending: 5 }))).toBe("pending");
  });

  it("is processing once work has started", () => {
    expect(deriveJobStatus(counts({ total: 5, pending: 3, done: 2 }))).toBe(
      "processing",
    );
    expect(deriveJobStatus(counts({ total: 5, pending: 4, processing: 1 }))).toBe(
      "processing",
    );
  });
});

describe("createWarrantyJob", () => {
  beforeEach(() => {
    mocks.extractSerials.mockResolvedValue({
      sheetName: "Report",
      headerRow: 1,
      serialColumn: 10,
      productColumn: 11,
      totalRows: 3,
      candidates: [
        {
          serial: "CACHED123",
          productNumber: "4WF66A",
          isNoSerial: false,
          rowCount: 1,
        },
        {
          serial: "UNKNOWN456",
          productNumber: "1MR75A",
          isNoSerial: false,
          rowCount: 1,
        },
        {
          serial: "A9T81B NOSN",
          productNumber: "A9T81B",
          isNoSerial: true,
          rowCount: 1,
        },
      ],
    });

    mocks.findCachedWarranties.mockResolvedValue([
      {
        serial: "CACHED123",
        lookupStatus: "OK",
        endDate: "2026-01-05",
        productNumber: "4WF66A",
        hpStatus: "Active",
        fetchedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);

    mocks.insertWarrantyJob.mockResolvedValue(jobRecord());
    mocks.countJobItems.mockResolvedValue(
      counts({ total: 3, pending: 1, done: 2, ok: 1, noSerial: 1 }),
    );
  });

  it("only asks the cache about serials that could reach HP", async () => {
    await createWarrantyJob({
      originalFileName: "flex-wip.xlsx",
      storedFilePath: "/storage/uploads/flex-wip.xlsx",
      createdBy: "user-1",
      regionId: null,
    });

    expect(mocks.findCachedWarranties).toHaveBeenCalledWith([
      "CACHED123",
      "UNKNOWN456",
    ]);
  });

  it("enqueues a cache hit as done, an unknown serial as pending, and NOSN as NO_SERIAL", async () => {
    await createWarrantyJob({
      originalFileName: "flex-wip.xlsx",
      storedFilePath: "/storage/uploads/flex-wip.xlsx",
      createdBy: "user-1",
      regionId: null,
    });

    const items = mocks.insertWarrantyJobItems.mock
      .calls[0]![0] as InsertWarrantyJobItemInput[];
    expect(items).toHaveLength(3);

    expect(items[0]).toEqual({
      jobId: JOB_ID,
      serial: "CACHED123",
      productNumber: "4WF66A",
      state: "done",
      lookupStatus: "OK",
      endDate: "2026-01-05",
      hpStatus: "Active",
    });

    expect(items[1]).toEqual({
      jobId: JOB_ID,
      serial: "UNKNOWN456",
      productNumber: "1MR75A",
      state: "pending",
      lookupStatus: null,
      endDate: null,
      hpStatus: null,
    });

    expect(items[2]).toEqual({
      jobId: JOB_ID,
      serial: "A9T81B NOSN",
      productNumber: "A9T81B",
      state: "done",
      lookupStatus: "NO_SERIAL",
      endDate: null,
      hpStatus: null,
    });
  });

  it("records the row and unique-serial totals on the job", async () => {
    const detail = await createWarrantyJob({
      originalFileName: "flex-wip.xlsx",
      storedFilePath: "/storage/uploads/flex-wip.xlsx",
      createdBy: "user-1",
      regionId: "region-1",
    });

    expect(mocks.insertWarrantyJob).toHaveBeenCalledWith({
      originalFileName: "flex-wip.xlsx",
      storedFilePath: "/storage/uploads/flex-wip.xlsx",
      status: "pending",
      totalRows: 3,
      uniqueSerials: 3,
      createdBy: "user-1",
      regionId: "region-1",
    });

    expect(detail.counts.total).toBe(3);
    // One item still queued, two already resolved → processing.
    expect(detail.status).toBe("processing");
  });
});

describe("getWarrantyJob", () => {
  it("derives the status from the item counts and persists the change", async () => {
    mocks.findWarrantyJobById.mockResolvedValue(jobRecord({ status: "processing" }));
    mocks.countJobItems.mockResolvedValue(
      counts({ total: 4, done: 3, failed: 1, ok: 2, notFound: 1, failedLookup: 1 }),
    );

    const detail = await getWarrantyJob(JOB_ID);

    expect(detail.status).toBe("completed");
    expect(mocks.updateWarrantyJobStatus).toHaveBeenCalledWith(JOB_ID, "completed");
    expect(detail.counts.failed).toBe(1);
  });

  it("leaves the stored status alone when it already matches", async () => {
    mocks.findWarrantyJobById.mockResolvedValue(jobRecord({ status: "processing" }));
    mocks.countJobItems.mockResolvedValue(
      counts({ total: 4, pending: 2, done: 2 }),
    );

    const detail = await getWarrantyJob(JOB_ID);

    expect(detail.status).toBe("processing");
    expect(mocks.updateWarrantyJobStatus).not.toHaveBeenCalled();
  });

  it("404s for an unknown job", async () => {
    mocks.findWarrantyJobById.mockResolvedValue(null);

    await expect(getWarrantyJob(JOB_ID)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("retryWarrantyJob", () => {
  it("resets the job's failed items back to pending", async () => {
    mocks.findWarrantyJobById.mockResolvedValue(jobRecord({ status: "completed" }));
    mocks.resetFailedItems.mockResolvedValue(2);
    mocks.countJobItems.mockResolvedValue(
      counts({ total: 4, pending: 2, done: 2, ok: 2 }),
    );

    const detail = await retryWarrantyJob(JOB_ID);

    expect(mocks.resetFailedItems).toHaveBeenCalledWith(JOB_ID);
    expect(detail.status).toBe("processing");
    expect(detail.counts.failed).toBe(0);
  });
});

describe("buildWarrantyJobFile", () => {
  it("409s while the job still has queued work", async () => {
    mocks.findWarrantyJobById.mockResolvedValue(jobRecord({ status: "processing" }));
    mocks.countJobItems.mockResolvedValue(counts({ total: 2, pending: 1, done: 1 }));

    await expect(buildWarrantyJobFile(JOB_ID)).rejects.toBeInstanceOf(HttpError);
    await expect(buildWarrantyJobFile(JOB_ID)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mocks.writeWarrantyWorkbook).not.toHaveBeenCalled();
  });

  it("writes the output workbook from the item results once completed", async () => {
    mocks.findWarrantyJobById.mockResolvedValue(jobRecord({ status: "completed" }));
    mocks.countJobItems.mockResolvedValue(
      counts({ total: 2, done: 2, ok: 1, noSerial: 1 }),
    );
    mocks.listJobItems.mockResolvedValue([
      {
        id: "item-1",
        jobId: JOB_ID,
        serial: "TH49J5D1FB",
        productNumber: "4WF66A",
        state: "done",
        lookupStatus: "OK",
        endDate: "2026-01-05",
        hpStatus: "Active",
        attempts: 1,
        lastError: null,
        lockedAt: null,
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z",
      },
      {
        id: "item-2",
        jobId: JOB_ID,
        serial: "A9T81B NOSN",
        productNumber: "A9T81B",
        state: "done",
        lookupStatus: "NO_SERIAL",
        endDate: null,
        hpStatus: null,
        attempts: 0,
        lastError: null,
        lockedAt: null,
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z",
      },
    ]);
    mocks.writeWarrantyWorkbook.mockResolvedValue({
      outputFilePath: "/storage/uploads/out.xlsx",
      rowsWritten: 2,
    });

    const file = await buildWarrantyJobFile(JOB_ID);

    expect(file.fileName).toBe("flex-wip-warranty.xlsx");

    const call = mocks.writeWarrantyWorkbook.mock.calls[0]![0] as {
      sourceFilePath: string;
      outputFilePath: string;
      resultsBySerial: Map<string, unknown>;
    };

    // The source is read, never written back to.
    expect(call.sourceFilePath).toBe("/storage/uploads/flex-wip.xlsx");
    expect(call.outputFilePath).not.toBe(call.sourceFilePath);
    expect(call.resultsBySerial.get("TH49J5D1FB")).toEqual({
      lookupStatus: "OK",
      endDate: "2026-01-05",
    });
    expect(call.resultsBySerial.get("A9T81B NOSN")).toEqual({
      lookupStatus: "NO_SERIAL",
      endDate: null,
    });
  });
});
