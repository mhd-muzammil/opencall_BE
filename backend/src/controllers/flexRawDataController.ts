import type { RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, forbidden } from "../utils/httpError.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import {
  allowedAspCodesForRequest,
  aspScopeToArray,
} from "../services/rbac/principalAspScope.js";
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
 * region cards. Readable by any authenticated principal, but scoped to the regions
 * that principal is granted — it previously returned every region's aggregate to a
 * two-region special-access credential.
 */
export const getFlexRawSummaryController: RequestHandler = asyncHandler(
  async (request, response) => {
    const summary = await summarizeFlexRawRecords();
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
        // Roll the headline totals up from the in-scope rows only, so they agree
        // with the cards rather than reporting the whole state's numbers.
        total: byAsp.reduce((sum, e) => sum + e.total, 0),
        closed: byAsp.reduce((sum, e) => sum + e.closed, 0),
      },
    });
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

    // `asp` is caller-supplied and was previously passed straight to SQL, so any
    // principal could read any region's closed cases by changing it. Reject an
    // out-of-scope code outright, and pass the scope down so `asp=''` ("every
    // region") stays bounded to what this principal may see.
    const allowed = await allowedAspCodesForRequest(request);
    if (allowed !== null && asp !== "" && !allowed.has(asp)) {
      throw forbidden("You do not have access to this region's raw data");
    }

    const result = await listFlexRawRecords({
      aspCode: asp,
      monthFrom: from,
      monthTo: to,
      statusGroup,
      allowedAspCodes: aspScopeToArray(allowed),
    });
    response.json({ data: result });
  },
);
