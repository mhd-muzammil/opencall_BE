import type { RequestHandler } from "express";
import { DAILY_CALL_PLAN_COLUMNS } from "@opencall/shared";
import {
  deleteUserRecordLayout,
  findColumnsUsedBySuperAdmins,
  findLatestFlexRawColumnHeaders,
  findUserRecordLayout,
  upsertUserRecordLayout,
} from "../repositories/userRecordLayoutRepository.js";
import { mergeNewStandardColumns } from "../services/reportRows/recordLayoutMerge.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";
import { recordLayoutSchema } from "../validators/recordLayoutValidator.js";

/**
 * The raw Excel headers a user may choose from. Super admins see every raw
 * header; region admins see only the ones a super admin has "enabled" (i.e.
 * included in a super admin layout). Standard report columns are always allowed.
 */
async function resolveExtraColumns(role: string): Promise<string[]> {
  const standardSet = new Set<string>(DAILY_CALL_PLAN_COLUMNS);
  const rawHeaders = await findLatestFlexRawColumnHeaders();
  const allExtras = rawHeaders.filter((h) => h && !standardSet.has(h));
  if (role === "SUPER_ADMIN") {
    return allExtras;
  }
  const enabled = new Set(await findColumnsUsedBySuperAdmins());
  return allExtras.filter((h) => enabled.has(h));
}

// Columns a user may choose from: the standard report columns plus the raw Excel
// headers available to their role (all for super admins; super-admin-enabled
// ones for region admins).
export const getRecordColumnsCatalogController: RequestHandler = asyncHandler(
  async (request, response) => {
    const current = requireCurrentUser(request.currentUser);
    const standard = [...DAILY_CALL_PLAN_COLUMNS];
    const extra = await resolveExtraColumns(current.role);
    response.json({ data: { standard, extra, columns: [...standard, ...extra] } });
  },
);

export const getRecordLayoutController: RequestHandler = asyncHandler(
  async (request, response) => {
    const current = requireCurrentUser(request.currentUser);
    const layout = await findUserRecordLayout(current.id);
    if (!layout) {
      response.json({ data: null });
      return;
    }

    // A saved layout lists only the columns to SHOW, so a report column added
    // after the layout was saved would be invisible to this user forever.
    response.json({
      data: {
        ...layout,
        orderedColumns: mergeNewStandardColumns({
          orderedColumns: layout.orderedColumns,
          knownColumns: layout.knownColumns,
          standardColumns: DAILY_CALL_PLAN_COLUMNS,
        }),
      },
    });
  },
);

export const putRecordLayoutController: RequestHandler = asyncHandler(
  async (request, response) => {
    const current = requireCurrentUser(request.currentUser);
    const input = recordLayoutSchema.parse(request.body);

    // Enforce the role's allowed set: standard columns + the raw Excel headers
    // available to this role. Blocks a region admin from saving a raw column a
    // super admin hasn't enabled.
    const allowed = new Set<string>(DAILY_CALL_PLAN_COLUMNS);
    for (const col of await resolveExtraColumns(current.role)) {
      allowed.add(col);
    }
    const disallowed = input.orderedColumns.filter((c) => !allowed.has(c));
    if (disallowed.length > 0) {
      throw badRequest("Layout contains columns not available to your role", {
        disallowed,
      });
    }

    const layout = await upsertUserRecordLayout({
      userId: current.id,
      orderedColumns: input.orderedColumns,
      // Everything the user could have chosen from, so a column shipped later is
      // distinguishable from one they chose to hide.
      knownColumns: [...allowed],
    });
    response.json({ data: layout });
  },
);

export const deleteRecordLayoutController: RequestHandler = asyncHandler(
  async (request, response) => {
    const current = requireCurrentUser(request.currentUser);
    await deleteUserRecordLayout(current.id);
    response.json({ data: { ok: true } });
  },
);
