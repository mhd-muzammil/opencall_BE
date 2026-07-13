import path from "node:path";
import type {
  WarrantyJob,
  WarrantyJobDetail,
  WarrantyJobItemCounts,
  WarrantyJobStatus,
} from "@opencall/shared";
import { findCachedWarranties } from "../../repositories/warrantyCacheRepository.js";
import {
  countJobItems,
  insertWarrantyJobItems,
  listJobItems,
  reclaimStaleProcessingItems,
  resetFailedItems,
  type InsertWarrantyJobItemInput,
} from "../../repositories/warrantyJobItemRepository.js";
import {
  findWarrantyJobById,
  insertWarrantyJob,
  updateWarrantyJobStatus,
  type WarrantyJobRecord,
} from "../../repositories/warrantyJobRepository.js";
import { conflict, notFound } from "../../utils/httpError.js";
import { extractSerials } from "./serialExtractor.js";
import {
  writeWarrantyWorkbook,
  type WarrantyRowResult,
} from "./warrantyExcelWriter.js";

/**
 * Orchestrates a warranty job: extract → pre-resolve from the permanent cache →
 * enqueue the rest → report progress → build the output workbook.
 *
 * The queue itself is `warranty_job_items`; the Playwright worker drains it out
 * of process. Nothing here touches a browser.
 */

function toWarrantyJob(record: WarrantyJobRecord): WarrantyJob {
  return {
    id: record.id,
    originalFileName: record.originalFileName,
    status: record.status,
    totalRows: record.totalRows,
    uniqueSerials: record.uniqueSerials,
    createdBy: record.createdBy,
    regionId: record.regionId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** A job is done once nothing is queued or in flight. Failed items do not block it. */
export function deriveJobStatus(counts: WarrantyJobItemCounts): WarrantyJobStatus {
  if (counts.pending === 0 && counts.processing === 0) {
    return "completed";
  }

  const hasStarted =
    counts.processing > 0 || counts.done > 0 || counts.failed > 0;
  return hasStarted ? "processing" : "pending";
}

/**
 * Reconciles the stored roll-up with the item counts. The worker only ever moves
 * individual items, so the job row is refreshed lazily whenever it is read.
 */
async function loadJobDetail(
  record: WarrantyJobRecord,
): Promise<WarrantyJobDetail> {
  const counts = await countJobItems(record.id);
  const status = deriveJobStatus(counts);

  let current = record;
  if (status !== record.status) {
    current = (await updateWarrantyJobStatus(record.id, status)) ?? {
      ...record,
      status,
    };
  }

  return { ...toWarrantyJob(current), counts };
}

async function requireJob(id: string): Promise<WarrantyJobRecord> {
  const job = await findWarrantyJobById(id);
  if (!job) {
    throw notFound("Warranty job not found");
  }
  return job;
}

export interface CreateWarrantyJobInput {
  originalFileName: string;
  storedFilePath: string;
  createdBy: string;
  regionId: string | null;
}

export async function createWarrantyJob(
  input: CreateWarrantyJobInput,
): Promise<WarrantyJobDetail> {
  const extraction = await extractSerials(input.storedFilePath);

  // Everything that could plausibly be looked up gets checked against the
  // permanent cache first — a serial is fetched from HP once, ever.
  const lookupableSerials = extraction.candidates
    .filter((candidate) => !candidate.isNoSerial)
    .map((candidate) => candidate.serial);
  const cached = await findCachedWarranties(lookupableSerials);
  const cacheBySerial = new Map(cached.map((entry) => [entry.serial, entry]));

  const job = await insertWarrantyJob({
    originalFileName: input.originalFileName,
    storedFilePath: input.storedFilePath,
    status: "pending",
    totalRows: extraction.totalRows,
    uniqueSerials: extraction.candidates.length,
    createdBy: input.createdBy,
    regionId: input.regionId,
  });

  const items: InsertWarrantyJobItemInput[] = extraction.candidates.map(
    (candidate): InsertWarrantyJobItemInput => {
      // Blank / NOSN: resolved without ever reaching HP.
      if (candidate.isNoSerial) {
        return {
          jobId: job.id,
          serial: candidate.serial,
          productNumber: candidate.productNumber,
          state: "done",
          lookupStatus: "NO_SERIAL",
          endDate: null,
          hpStatus: null,
        };
      }

      const hit = cacheBySerial.get(candidate.serial);
      if (hit) {
        return {
          jobId: job.id,
          serial: candidate.serial,
          productNumber: candidate.productNumber ?? hit.productNumber,
          state: "done",
          lookupStatus: hit.lookupStatus,
          endDate: hit.endDate,
          hpStatus: hit.hpStatus,
        };
      }

      return {
        jobId: job.id,
        serial: candidate.serial,
        productNumber: candidate.productNumber,
        state: "pending",
        lookupStatus: null,
        endDate: null,
        hpStatus: null,
      };
    },
  );

  await insertWarrantyJobItems(items);

  return loadJobDetail(job);
}

export async function getWarrantyJob(id: string): Promise<WarrantyJobDetail> {
  return loadJobDetail(await requireJob(id));
}

/** How long an item may sit in `processing` before Retry treats it as abandoned. */
const STALE_LOCK_SECONDS = 300;
const MAX_ATTEMPTS = 5;

export async function retryWarrantyJob(id: string): Promise<WarrantyJobDetail> {
  const job = await requireJob(id);
  await resetFailedItems(job.id);
  // Also rescue items abandoned in `processing` by a crashed worker — otherwise
  // Retry cannot unstick a job that a crash left permanently incomplete.
  await reclaimStaleProcessingItems(STALE_LOCK_SECONDS, MAX_ATTEMPTS, job.id);
  return loadJobDetail(job);
}

export interface WarrantyJobFile {
  filePath: string;
  /** Suggested download name, e.g. `flex-wip-warranty.xlsx`. */
  fileName: string;
}

/** Output lives next to the upload under a distinct name — the source is never touched. */
function buildOutputPath(job: WarrantyJobRecord): string {
  return path.join(
    path.dirname(job.storedFilePath),
    `${job.id}-warranty.xlsx`,
  );
}

function buildDownloadName(originalFileName: string): string {
  const extension = path.extname(originalFileName) || ".xlsx";
  const base = path.basename(originalFileName, extension);
  return `${base}-warranty.xlsx`;
}

export async function buildWarrantyJobFile(id: string): Promise<WarrantyJobFile> {
  const job = await requireJob(id);
  const detail = await loadJobDetail(job);

  if (detail.status !== "completed") {
    throw conflict("Warranty job is still processing", {
      jobId: job.id,
      status: detail.status,
      counts: detail.counts,
    });
  }

  const items = await listJobItems(job.id);
  const resultsBySerial = new Map<string, WarrantyRowResult>();
  for (const item of items) {
    if (!item.lookupStatus) {
      continue;
    }
    resultsBySerial.set(item.serial, {
      lookupStatus: item.lookupStatus,
      endDate: item.endDate,
    });
  }

  const outputFilePath = buildOutputPath(job);
  await writeWarrantyWorkbook({
    sourceFilePath: job.storedFilePath,
    outputFilePath,
    resultsBySerial,
  });

  return {
    filePath: outputFilePath,
    fileName: buildDownloadName(job.originalFileName),
  };
}
