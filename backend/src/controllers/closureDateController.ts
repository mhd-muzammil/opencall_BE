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

    const asp = String(request.query.asp ?? "").trim().toUpperCase();
    // Same guard as /records: an out-of-scope `asp` is a 403, never a silent empty list.
    const allowed = await allowedAspCodesForRequest(request);
    if (allowed !== null && asp !== "" && !allowed.has(asp)) {
      throw forbidden("You do not have access to this region's closure records");
    }

    response.json({
      data: await reconcileClosuresForDate({
        date,
        allowedAspCodes: aspScopeToArray(allowed),
        aspCode: asp,
      }),
    });
  },
);
