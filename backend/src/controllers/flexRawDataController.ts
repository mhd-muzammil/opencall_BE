import type { RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import {
  isFlexRawSyncConfigured,
  syncFlexRawDataFromApi,
} from "../services/flexRawData/flexRawSyncService.js";
import {
  listFlexRawRecords,
  summarizeFlexRawRecords,
} from "../repositories/flexRawRecordRepository.js";
import { monthRange } from "../utils/monthRange.js";
import { recordActivity } from "../services/audit/activityLogger.js";

/**
 * Pulls the Flex raw closed-call rows from the standalone raw-data project's API and
 * replaces the stored raw record set. Replaces the old manual Excel upload — the data now
 * comes straight from that project over HTTP.
 */
export const syncFlexRawDataController: RequestHandler = asyncHandler(
  async (request, response) => {
    const currentUser = requireCurrentUser(request.currentUser);

    if (!isFlexRawSyncConfigured()) {
      throw badRequest(
        "Raw data API is not configured. Set FLEX_RAW_API_URL in the backend environment.",
      );
    }

    const result = await syncFlexRawDataFromApi();

    recordActivity({
      eventType: "UPLOAD_CREATED",
      actor: {
        id: currentUser.id,
        email: currentUser.email,
        role: currentUser.role,
      },
      regionId: currentUser.regionId ?? null,
      targetType: "flex_raw_records",
      metadata: {
        kind: "FLEX_RAW_SYNC",
        ...result,
      },
      request,
    });

    response.json({ data: result });
  },
);

/**
 * Per-ASP, per-month closed counts from the imported raw data, for the Closed Calls
 * region cards. Readable by any authenticated principal — it is the same aggregate the
 * cards show.
 */
export const getFlexRawSummaryController: RequestHandler = asyncHandler(
  async (_request, response) => {
    const summary = await summarizeFlexRawRecords();
    response.json({ data: summary });
  },
);

/**
 * The raw records behind a card's "Raw data closed" count. Query params:
 *   asp    — ASP code, or "" for every region
 *   from   — earliest "YYYY-MM" (inclusive), or "" for no lower bound
 *   to     — latest "YYYY-MM" (inclusive), or "" for no upper bound
 *   status — status group (defaults to "closed"), or "" for every status
 */
export const listFlexRawRecordsController: RequestHandler = asyncHandler(
  async (request, response) => {
    const asp = String(request.query.asp ?? "").trim().toUpperCase();
    const { from, to } = monthRange(request.query.from, request.query.to);
    const statusRaw = request.query.status;
    const statusGroup =
      statusRaw === undefined ? "closed" : String(statusRaw).trim().toLowerCase();

    const result = await listFlexRawRecords({
      aspCode: asp,
      monthFrom: from,
      monthTo: to,
      statusGroup,
    });
    response.json({ data: result });
  },
);
