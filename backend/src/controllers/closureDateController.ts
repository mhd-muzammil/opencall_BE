import fs from "node:fs";
import type { RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import { importClosureDatesFromFile } from "../services/closureDates/closureDateImportService.js";
import {
  countCaseClosureDates,
  listCaseClosureDatesForAsp,
  summarizeCaseClosureDatesByAsp,
} from "../repositories/caseClosureDateRepository.js";
import { monthRange } from "../utils/monthRange.js";
import { recordActivity } from "../services/audit/activityLogger.js";

/**
 * Imports the Flex Closure ASP Report: parses the uploaded Excel and replaces the stored
 * closure-date set. The uploaded file is always deleted afterwards. Regenerating or
 * reopening a report then shows each matched row's Case Closed Date.
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

    try {
      const result = await importClosureDatesFromFile(file.path);

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
          kind: "CLOSURE_DATES_IMPORT",
          originalFileName: file.originalname,
          ...result,
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

/** How many closure dates are currently stored (for a small status line in the UI). */
export const getClosureDatesStatusController: RequestHandler = asyncHandler(
  async (_request, response) => {
    const count = await countCaseClosureDates();
    response.json({ data: { count } });
  },
);

/**
 * Per-ASP breakdown of the imported closure dates, for the Closed Calls region cards.
 * Optional `from` / `to` day-precise date bounds ("YYYY-MM-DD") scope the counts.
 * Readable by any principal — special-access logins see those cards too.
 */
export const getClosureDatesSummaryController: RequestHandler = asyncHandler(
  async (request, response) => {
    const { from, to } = monthRange(request.query.from, request.query.to);
    const summary = await summarizeCaseClosureDatesByAsp({ dateFrom: from, dateTo: to });
    response.json({ data: summary });
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
    const result = await listCaseClosureDatesForAsp({
      aspCode: asp,
      dateFrom: from,
      dateTo: to,
    });
    response.json({ data: result });
  },
);
