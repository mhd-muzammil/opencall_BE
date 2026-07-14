import type { Request, RequestHandler } from "express";
import { DAILY_CALL_PLAN_COLUMNS } from "@opencall/shared";
import type { SpecialAccessPrincipal } from "../types/auth.js";
import { loadScopedReportForPrincipal } from "../services/specialAccess/specialAccessReportService.js";
import {
  deleteSpecialAccessRecordLayout,
  findSpecialAccessRecordLayout,
  upsertSpecialAccessRecordLayout,
} from "../repositories/specialAccessRecordLayoutRepository.js";
import {
  findColumnsUsedBySuperAdmins,
  findLatestFlexRawColumnHeaders,
} from "../repositories/userRecordLayoutRepository.js";
import { updateReportRowForSpecialAccess } from "../services/specialAccess/specialAccessRowEditService.js";
import type { ReportRowEditInput } from "../services/reportRows/reportRowEditService.js";
import { recordActivity } from "../services/audit/activityLogger.js";
import { recordLayoutSchema } from "../validators/recordLayoutValidator.js";
import { reportRowEditRequestSchema } from "../validators/reportRowEditRequestValidator.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, forbidden } from "../utils/httpError.js";

/** Ensures the caller is a special-access principal (not a regular user). */
function requireSpecialAccess(request: Request): SpecialAccessPrincipal {
  if (!request.specialAccess) {
    throw forbidden("This endpoint is only for special-access logins");
  }
  return request.specialAccess;
}

/** The "record-format" section must be granted on the credential. */
function requireRecordFormatSection(
  principal: SpecialAccessPrincipal,
): SpecialAccessPrincipal {
  if (!principal.sections.includes("record-format")) {
    throw forbidden("Record Format is not granted to this credential");
  }
  return principal;
}

/**
 * Raw Excel headers a special-access credential may choose from. Same rule as a
 * region admin: only the headers a SUPER_ADMIN has "enabled" by including them in
 * their own layout. Standard report columns are always allowed.
 */
async function resolveSpecialAccessExtraColumns(): Promise<string[]> {
  const standardSet = new Set<string>(DAILY_CALL_PLAN_COLUMNS);
  const rawHeaders = await findLatestFlexRawColumnHeaders();
  const enabled = new Set(await findColumnsUsedBySuperAdmins());
  return rawHeaders.filter((h) => h && !standardSet.has(h) && enabled.has(h));
}

export const getSpecialAccessMeController: RequestHandler = asyncHandler(
  async (request, response) => {
    const principal = requireSpecialAccess(request);
    response.json({ data: principal });
  },
);

export const getSpecialAccessReportController: RequestHandler = asyncHandler(
  async (request, response) => {
    const principal = requireSpecialAccess(request);
    const result = await loadScopedReportForPrincipal(principal);
    response.json({ data: result });
  },
);

// ---------------------------------------------------------------------------
// Record Format — the credential's own records-grid column layout.
// Affects only that credential's own view and its own Excel/CSV export; it is not
// a data edit, so it is available at both the `view` and `edit` permission levels.
// ---------------------------------------------------------------------------

export const getSpecialAccessRecordColumnsCatalogController: RequestHandler =
  asyncHandler(async (request, response) => {
    requireRecordFormatSection(requireSpecialAccess(request));
    const standard = [...DAILY_CALL_PLAN_COLUMNS];
    const extra = await resolveSpecialAccessExtraColumns();
    response.json({ data: { standard, extra, columns: [...standard, ...extra] } });
  });

export const getSpecialAccessRecordLayoutController: RequestHandler = asyncHandler(
  async (request, response) => {
    // Read of the credential's own layout — no section check, so the Records table
    // still honours a saved layout even if Record Format is later un-granted.
    const principal = requireSpecialAccess(request);
    const layout = await findSpecialAccessRecordLayout(principal.id);
    response.json({ data: layout });
  },
);

export const putSpecialAccessRecordLayoutController: RequestHandler = asyncHandler(
  async (request, response) => {
    const principal = requireRecordFormatSection(requireSpecialAccess(request));
    const input = recordLayoutSchema.parse(request.body);

    const allowed = new Set<string>(DAILY_CALL_PLAN_COLUMNS);
    for (const col of await resolveSpecialAccessExtraColumns()) {
      allowed.add(col);
    }
    const disallowed = input.orderedColumns.filter((c) => !allowed.has(c));
    if (disallowed.length > 0) {
      throw badRequest("Layout contains columns not available to your access", {
        disallowed,
      });
    }

    const layout = await upsertSpecialAccessRecordLayout({
      specialAccessId: principal.id,
      orderedColumns: input.orderedColumns,
    });
    response.json({ data: layout });
  },
);

export const deleteSpecialAccessRecordLayoutController: RequestHandler = asyncHandler(
  async (request, response) => {
    const principal = requireRecordFormatSection(requireSpecialAccess(request));
    await deleteSpecialAccessRecordLayout(principal.id);
    response.json({ data: { ok: true } });
  },
);

// ---------------------------------------------------------------------------
// Record-row editing (the Records table "Save Entry" modal).
// The service re-checks permission level, granted section, region and data scope
// server-side, so a credential can only ever edit a row it is allowed to see.
// ---------------------------------------------------------------------------

export const patchSpecialAccessReportRowController: RequestHandler = asyncHandler(
  async (request, response) => {
    const principal = requireSpecialAccess(request);
    const rowId = request.params.id?.trim();
    if (!rowId) {
      throw badRequest("Missing report row id");
    }

    const parsed = reportRowEditRequestSchema.parse(request.body);
    const values = Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value !== undefined),
    ) as ReportRowEditInput;

    const row = await updateReportRowForSpecialAccess({ rowId, principal, values });

    // A special-access credential is not a `users` row, so the activity log's
    // actor_user_id (FK -> users.id) and actor_role (user_role enum) stay null; the
    // credential is identified by the email fallback and the metadata below.
    recordActivity({
      eventType: "REPORT_ROW_EDITED",
      actorEmailFallback: `special-access:${principal.username}`,
      regionId: row.regionId ?? null,
      targetType: "report_row",
      targetId: row.id,
      metadata: {
        specialAccessId: principal.id,
        specialAccessUsername: principal.username,
        reportId: row.reportId,
        serialNo: row.serialNo,
        ticketId: row.ticketId,
        caseId: row.caseId,
        workLocation: row.workLocation,
        changedFields: Object.keys(values),
        ...(row.rtplStatusChange
          ? {
              rtplStatusChange: {
                fromStatus: row.rtplStatusChange.fromStatus,
                toStatus: row.rtplStatusChange.toStatus,
              },
            }
          : {}),
      },
      request,
    });

    response.json({ data: row });
  },
);
