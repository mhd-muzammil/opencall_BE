import type {
  ClosedCallWarrantyEntry,
  ClosedCallWarrantyListResponse,
  ClosedCallWarrantyListRow,
  ClosedCallWarrantyResponse,
  ClosedCallWarrantyStatus,
} from "@opencall/shared";
import {
  findCachedWarranties,
  type WarrantyCacheEntry,
} from "../../repositories/warrantyCacheRepository.js";
import { insertWarrantyJobItems } from "../../repositories/warrantyJobItemRepository.js";
import {
  countEnqueuedTodayForJob,
  findQueuedSerials,
  getLatestReportClosedCalls,
  getLatestReportClosedSerials,
  getOrCreateClosedCallsJobId,
  warrantyTablesPresent,
} from "../../repositories/closedCallWarrantyRepository.js";
import { isNoSerialValue, normalizeSerial } from "./serialExtractor.js";

/**
 * Closed calls ↔ HP warranty. Reuses the permanent cache + the worker queue:
 *   - display: resolve each closed call's serial against hp_warranty_cache (+ queue state)
 *   - enqueue: uncached serials are pushed onto the standing closed-calls job, capped at
 *     ~100 NEW serials/day so the reCAPTCHA-paced worker is never overwhelmed
 * A serial is only ever fetched from HP once (the cache dedupes), so no duplicates.
 */

const DAILY_LOOKUP_CAP = 100;

/** Today's date in IST (YYYY-MM-DD) for the in/out-of-warranty comparison. */
function todayIstIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function deriveResolvedStatus(hit: WarrantyCacheEntry): ClosedCallWarrantyStatus {
  if (hit.lookupStatus === "NOT_FOUND") return "NOT_FOUND";
  // OK: HP returned an entitlement. In warranty if the end date is today or later.
  if (hit.endDate) {
    return hit.endDate >= todayIstIso() ? "IN_WARRANTY" : "OUT_OF_WARRANTY";
  }
  // OK but no end date parsed — fall back to HP's status word.
  if (hit.hpStatus && /active|in.?warranty/i.test(hit.hpStatus)) return "IN_WARRANTY";
  return "OUT_OF_WARRANTY";
}

/**
 * Enqueue up to the remaining daily budget of the given uncached serials onto the standing
 * closed-calls job. Shared by the on-view path and the worker sweep. Returns how many were
 * newly enqueued and the remaining daily budget.
 */
async function enqueueUncached(
  uncached: readonly string[],
): Promise<{ enqueued: number; dailyRemaining: number; queued: Set<string> }> {
  const jobId = await getOrCreateClosedCallsJobId();
  const today = await countEnqueuedTodayForJob(jobId);
  const remaining = Math.max(0, DAILY_LOOKUP_CAP - today);
  const toEnqueue = uncached.slice(0, remaining);

  let enqueued = 0;
  if (toEnqueue.length > 0) {
    enqueued = await insertWarrantyJobItems(
      toEnqueue.map((serial) => ({
        jobId,
        serial,
        productNumber: null,
        state: "pending" as const,
        lookupStatus: null,
        endDate: null,
        hpStatus: null,
      })),
    );
  }
  return {
    enqueued,
    dailyRemaining: Math.max(0, remaining - enqueued),
    queued: new Set(toEnqueue),
  };
}

/**
 * Resolves warranty status for a set of closed-call serials AND enqueues the uncached ones
 * (capped) so the list fills as the worker runs. Returns one entry per unique input serial,
 * keyed by the serial exactly as supplied so the caller can join it back to its row.
 */
export async function getClosedCallWarrantyStatuses(
  rawSerials: readonly string[],
): Promise<ClosedCallWarrantyResponse> {
  if (!(await warrantyTablesPresent())) {
    return { entries: [], enqueued: 0, dailyRemaining: 0, available: false };
  }

  const uniqueRaw = [...new Set(rawSerials)];
  // raw -> { normalized, isNoSerial }
  const info = new Map<string, { normalized: string; isNoSerial: boolean }>();
  for (const raw of uniqueRaw) {
    const normalized = normalizeSerial(raw);
    info.set(raw, {
      normalized,
      isNoSerial: normalized === "" || isNoSerialValue(raw),
    });
  }

  const lookupable = [
    ...new Set(
      [...info.values()].filter((v) => !v.isNoSerial).map((v) => v.normalized),
    ),
  ];

  const cached = await findCachedWarranties(lookupable);
  const cacheBySerial = new Map(cached.map((c) => [c.serial, c]));
  const queued = new Set(await findQueuedSerials(lookupable));

  const uncached = lookupable.filter(
    (s) => !cacheBySerial.has(s) && !queued.has(s),
  );

  let enqueued = 0;
  let dailyRemaining = DAILY_LOOKUP_CAP;
  if (uncached.length > 0) {
    const result = await enqueueUncached(uncached);
    enqueued = result.enqueued;
    dailyRemaining = result.dailyRemaining;
    for (const s of result.queued) queued.add(s);
  } else {
    const jobId = await getOrCreateClosedCallsJobId();
    dailyRemaining = Math.max(0, DAILY_LOOKUP_CAP - (await countEnqueuedTodayForJob(jobId)));
  }

  const entries: ClosedCallWarrantyEntry[] = uniqueRaw.map((raw) => {
    const meta = info.get(raw)!;
    if (meta.isNoSerial) {
      return { serial: raw, status: "NO_SERIAL", endDate: null, hpStatus: null };
    }
    const hit = cacheBySerial.get(meta.normalized);
    if (hit) {
      return {
        serial: raw,
        status: deriveResolvedStatus(hit),
        endDate: hit.endDate,
        hpStatus: hit.hpStatus,
      };
    }
    return {
      serial: raw,
      status: queued.has(meta.normalized) ? "CHECKING" : "NOT_CHECKED",
      endDate: null,
      hpStatus: null,
    };
  });

  return { entries, enqueued, dailyRemaining, available: true };
}

/**
 * Self-contained list for the Warranty Lookup section: the latest report's closed calls +
 * each one's warranty status, resolved server-side. Also enqueues the uncached serials
 * (capped ~100/day) so the list fills as the worker runs. No client-side report needed.
 */
export async function getClosedCallWarrantyList(): Promise<ClosedCallWarrantyListResponse> {
  if (!(await warrantyTablesPresent())) {
    return { rows: [], enqueued: 0, dailyRemaining: 0, available: false };
  }

  const closedCalls = await getLatestReportClosedCalls();

  // Normalise each call's serial once; classify NO_SERIAL up front.
  const normalized = closedCalls.map((call) => {
    const serial = normalizeSerial(call.serial);
    return {
      call,
      serial,
      isNoSerial: serial === "" || isNoSerialValue(call.serial),
    };
  });

  const lookupable = [
    ...new Set(normalized.filter((n) => !n.isNoSerial).map((n) => n.serial)),
  ];

  const cached = await findCachedWarranties(lookupable);
  const cacheBySerial = new Map(cached.map((c) => [c.serial, c]));
  const queued = new Set(await findQueuedSerials(lookupable));

  const uncached = lookupable.filter(
    (s) => !cacheBySerial.has(s) && !queued.has(s),
  );

  let enqueued = 0;
  let dailyRemaining = DAILY_LOOKUP_CAP;
  if (uncached.length > 0) {
    const result = await enqueueUncached(uncached);
    enqueued = result.enqueued;
    dailyRemaining = result.dailyRemaining;
    for (const s of result.queued) queued.add(s);
  } else {
    const jobId = await getOrCreateClosedCallsJobId();
    dailyRemaining = Math.max(0, DAILY_LOOKUP_CAP - (await countEnqueuedTodayForJob(jobId)));
  }

  const rows: ClosedCallWarrantyListRow[] = normalized.map(({ call, serial, isNoSerial }) => {
    let status: ClosedCallWarrantyStatus;
    let startDate: string | null = null;
    let endDate: string | null = null;
    let hpStatus: string | null = null;
    if (isNoSerial) {
      status = "NO_SERIAL";
    } else {
      const hit = cacheBySerial.get(serial);
      if (hit) {
        status = deriveResolvedStatus(hit);
        startDate = hit.startDate;
        endDate = hit.endDate;
        hpStatus = hit.hpStatus;
      } else {
        status = queued.has(serial) ? "CHECKING" : "NOT_CHECKED";
      }
    }
    return {
      ticketId: call.ticketId || "-",
      customer: call.customer || "-",
      serial: call.serial,
      region: call.region || "-",
      model: call.model || "-",
      status,
      startDate,
      endDate,
      hpStatus,
    };
  });

  return { rows, enqueued, dailyRemaining, available: true };
}

/**
 * Unattended daily sweep run by the warranty worker: enqueues up to the remaining daily
 * budget of uncached serials from the latest report's closed calls. Idempotent + capped, so
 * it is safe to call repeatedly.
 */
export async function runDailyClosedCallSweep(): Promise<{ enqueued: number }> {
  if (!(await warrantyTablesPresent())) return { enqueued: 0 };

  const serials = [
    ...new Set(
      (await getLatestReportClosedSerials())
        .map((s) => normalizeSerial(s))
        .filter((s) => s !== "" && !isNoSerialValue(s)),
    ),
  ];
  if (serials.length === 0) return { enqueued: 0 };

  const cached = new Set((await findCachedWarranties(serials)).map((c) => c.serial));
  const queued = new Set(await findQueuedSerials(serials));
  const uncached = serials.filter((s) => !cached.has(s) && !queued.has(s));
  if (uncached.length === 0) return { enqueued: 0 };

  const { enqueued } = await enqueueUncached(uncached);
  return { enqueued };
}
