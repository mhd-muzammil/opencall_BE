import fs from "node:fs";
import type { RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import { importClosureDatesFromFile } from "../services/closureDates/closureDateImportService.js";
import { countCaseClosureDates } from "../repositories/caseClosureDateRepository.js";
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
