import fs from "node:fs";
import type { RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, forbidden } from "../utils/httpError.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import {
  allowedAspCodesForRequest,
  aspScopeToArray,
} from "../services/rbac/principalAspScope.js";
import {
  importClosureDatesFromFile,
  type ClosureImportMode,
} from "../services/closureDates/closureDateImportService.js";
import {
  getClosureImportStatus,
  listCaseClosureDatesForAsp,
  summarizeCaseClosureDatesByAsp,
} from "../repositories/caseClosureDateRepository.js";
import { reconcileClosuresForDate } from "../services/closureDates/closureReconciliationService.js";
import { monthRange } from "../utils/monthRange.js";
import { recordActivity } from "../services/audit/activityLogger.js";

/**
 * Imports the Flex Closure ASP Report. Two modes, chosen by the optional `mode` field:
 *
 *   replace (default) — the manual "Import Closure Dates" button. Wipes and reloads the
 *                       whole set, exactly as it always has.
 *   merge             — the hourly FieldEZ auto-sync. Touches ONLY the work orders in
 *                       this file, so a today-only download cannot erase history.
 *
 * The uploaded file is always deleted afterwards. Regenerating or reopening a report then
 * shows each matched row's Case Closed Date and the vendor's own Flex Status.
 */
export const importClosureDatesController: RequestHandler = asyncHandler(
  async (request, response) => {
    const currentUser = requireCurrentUser(request.currentUser);
    const file = request.file;
    if (!file) {
      throw badRequest("No closure report file was uploaded", {
        field: "closureReport",
      });
    }

    // Multipart fields arrive as strings. Anything other than an explicit "merge" keeps
    // the historical replace behaviour, so an older client is unaffected.
    const rawMode = String(request.body?.mode ?? "").trim().toLowerCase();
    const mode: ClosureImportMode = rawMode === "merge" ? "merge" : "replace";
    const isAuto = String(request.body?.source ?? "").trim().toUpperCase() === "AUTO";

    try {
      const result = await importClosureDatesFromFile(file.path, {
        mode,
        importSource: isAuto ? "AUTO" : "MANUAL",
      });

      recordActivity({
        eventType: "UPLOAD_CREATED",
        actor: {
          id: currentUser.id,
          email: currentUser.email,
          role: currentUser.role,
        },
        regionId: currentUser.regionId ?? null,
        targetType: "closure_dates",
        metadata: {
          kind: isAuto ? "CLOSURE_DATES_AUTO_IMPORT" : "CLOSURE_DATES_IMPORT",
          originalFileName: file.originalname,
          ...result,
          // Flattened so the activity log is filterable without digging into an object.
          closedCount: result.byStatus.closed,
          cancelledCount: result.byStatus.cancelled,
          otherStatusCount: result.byStatus.other,
        },
        request,
      });

      response.status(201).json({ data: result });
    } finally {
      fs.promises.unlink(file.path).catch(() => {
        /* best-effort cleanup */
      });
    }
  },
);

/**
 * Closure-data freshness for the Closed Calls status line: how many records are stored,
 * when the last one arrived, whether it came from the worker or a person, and the latest
 * closure day covered. `lastImportedAt` is what lets the UI show a dead worker — a stale
 * table otherwise looks identical to a healthy one.
 */
export const getClosureDatesStatusController: RequestHandler = asyncHandler(
  async (_request, response) => {
    response.json({ data: await getClosureImportStatus() });
  },
);

/**
 * Per-ASP breakdown of the imported closure dates, for the Closed Calls region cards.
 * Optional `from` / `to` day-precise date bounds ("YYYY-MM-DD") scope the counts.
 * Readable by any principal, but restricted to the regions that principal is granted —
 * it previously returned every region's breakdown to a region-scoped credential.
 */
export const getClosureDatesSummaryController: RequestHandler = asyncHandler(
  async (request, response) => {
    const { from, to } = monthRange(request.query.from, request.query.to);
    const summary = await summarizeCaseClosureDatesByAsp({ dateFrom: from, dateTo: to });
    const allowed = await allowedAspCodesForRequest(request);

    if (allowed === null) {
      response.json({ data: summary });
      return;
    }

    const inScope = (aspCode: string) => allowed.has(aspCode.trim().toUpperCase());
    const byAsp = summary.byAsp.filter((entry) => inScope(entry.aspCode));
    response.json({
      data: {
        ...summary,
        byAsp,
        byAspMonth: summary.byAspMonth.filter((entry) => inScope(entry.aspCode)),
        total: byAsp.reduce((sum, entry) => sum + entry.count, 0),
        // "Unmatched" rows traced to no Work Location, so they belong to no region
        // and must not be attributed to a region-scoped principal.
        unmatched: 0,
      },
    });
  },
);

/**
 * The closure dates behind a region card's "Closure import" count. Query params:
 *   asp  — recovered ASP code, or "" for every region (includes unmatched)
 *   from — earliest "YYYY-MM-DD" (inclusive), or "" for no lower bound
 *   to   — latest "YYYY-MM-DD" (inclusive), or "" for no upper bound
 */
export const listClosureDateRecordsController: RequestHandler = asyncHandler(
  async (request, response) => {
    const asp = String(request.query.asp ?? "").trim().toUpperCase();
    const { from, to } = monthRange(request.query.from, request.query.to);

    // `asp` is caller-supplied and went straight to SQL, so any principal could read
    // any region's closure records by changing it. Reject an out-of-scope code, and
    // pass the scope down so `asp=''` ("every region", which also sweeps in rows that
    // matched no region) stays bounded to what this principal may see.
    const allowed = await allowedAspCodesForRequest(request);
    if (allowed !== null && asp !== "" && !allowed.has(asp)) {
      throw forbidden("You do not have access to this region's closure records");
    }

    const result = await listCaseClosureDatesForAsp({
      aspCode: asp,
      dateFrom: from,
      dateTo: to,
      allowedAspCodes: aspScopeToArray(allowed),
    });
    response.json({ data: result });
  },
);

const RECONCILIATION_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The longest period one reconciliation request may ask about.
 *
 * Thirty-one days covers "this month", which is the question people actually ask. Beyond
 * that the query stops being a lookup and becomes a report: it reads every row of every
 * daily report in the period and window-functions over them, holding one of the API's ten
 * database connections for as long as it runs.
 */
export const MAX_RECONCILIATION_DAYS = 31;

/**
 * Whole days from one YYYY-MM-DD to another, both parsed as UTC midnight.
 *
 * UTC on both sides on purpose: parsed as local dates, a range spanning a daylight-saving
 * change is 30.96 days and rounds differently than the same range in January. The bound is
 * about how much work the query does, and that does not change with the clocks.
 *
 * Exported for the tests that pin the boundary — an off-by-one in a guard is a guard that
 * lets through exactly the request it was written to stop.
 */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

/**
 * "Did Flex agree with us on this day?" Query params:
 *   date — "YYYY-MM-DD" (required)
 *   asp  — narrow to one ASP code, or "" for every region the caller may read
 *
 * Three buckets: closed on both sides, closed here but not in Flex, closed in Flex but
 * not here. Purely informational — nothing is auto-closed.
 */
export const getClosureReconciliationController: RequestHandler = asyncHandler(
  async (request, response) => {
    const date = String(request.query.date ?? "").trim();
    if (!RECONCILIATION_DATE.test(date)) {
      throw badRequest("A `date` of the form YYYY-MM-DD is required", {
        field: "date",
      });
    }

    // The last day of the period, inclusive. Absent means the single day `date`, which is
    // what this endpoint has always answered — so a caller that sends no `to` gets the
    // identical query it got before the range existed.
    const toDate = String(request.query.to ?? "").trim();
    if (toDate && !RECONCILIATION_DATE.test(toDate)) {
      throw badRequest("`to` must be of the form YYYY-MM-DD", { field: "to" });
    }
    // Refused rather than swapped: a range quietly turned around would report a period
    // nobody chose and nobody would notice choosing.
    if (toDate && toDate < date) {
      throw badRequest("`to` must be on or after `date`", { field: "to" });
    }
    // A ceiling on how much work one request may ask for.
    //
    // Reconciliation reads every report row in the period and window-functions over them.
    // One day is cheap; a quarter is not, and it holds one of the API's ten database
    // connections for as long as it takes. On 2026-08-27 that pool was emptied by two
    // concurrent report generations and everything else on the server — login, the health
    // check — began failing with "timeout exceeded when trying to connect". A range nobody
    // bounded is a second way to reach the same place, from a date picker.
    //
    // Thirty-one days covers "this month", which is the question actually being asked.
    if (toDate && daysBetween(date, toDate) > MAX_RECONCILIATION_DAYS) {
      throw badRequest(
        `A reconciliation period may span at most ${MAX_RECONCILIATION_DAYS} days`,
        { field: "to" },
      );
    }

    const asp = String(request.query.asp ?? "").trim().toUpperCase();
    // Same guard as /records: an out-of-scope `asp` is a 403, never a silent empty list.
    const allowed = await allowedAspCodesForRequest(request);
    if (allowed !== null && asp !== "" && !allowed.has(asp)) {
      throw forbidden("You do not have access to this region's closure records");
    }

    response.json({
      data: await reconcileClosuresForDate({
        date,
        ...(toDate ? { toDate } : {}),
        allowedAspCodes: aspScopeToArray(allowed),
        aspCode: asp,
      }),
    });
  },
);
