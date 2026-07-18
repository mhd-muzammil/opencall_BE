import type { RequestHandler } from "express";
import { z } from "zod";
import { recordActivity } from "../services/audit/activityLogger.js";
import {
  closeRegionEod,
  getRegionEodState,
  getReportProductivity,
  reopenRegionEod,
} from "../services/productivity/eodService.js";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const regionIdSchema = z.string().uuid();
const workingDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const eodActionBodySchema = z.object({
  workingDate: workingDateSchema,
});

export const closeRegionEodController: RequestHandler = asyncHandler(
  async (request, response) => {
    const currentUser = requireCurrentUser(request.currentUser);
    const regionId = regionIdSchema.parse(request.params.regionId);
    const { workingDate } = eodActionBodySchema.parse(request.body);

    const result = await closeRegionEod(currentUser, regionId, workingDate);

    // Only a close that actually froze the day is audit-worthy; an idempotent
    // re-click changed nothing.
    if (result.frozenNow) {
      recordActivity({
        eventType: "REGION_EOD_CLOSED",
        actor: {
          id: currentUser.id,
          email: currentUser.email,
          role: currentUser.role,
        },
        regionId,
        targetType: "region_eod",
        targetId: result.state.id,
        metadata: {
          workingDate,
          engineerCount: result.snapshot.list.length,
          totalAttended: result.snapshot.totalAttended,
        },
        request,
      });
    }

    response.json({ data: result });
  },
);

export const reopenRegionEodController: RequestHandler = asyncHandler(
  async (request, response) => {
    const currentUser = requireCurrentUser(request.currentUser);
    const regionId = regionIdSchema.parse(request.params.regionId);
    const { workingDate } = eodActionBodySchema.parse(request.body);

    const result = await reopenRegionEod(currentUser, regionId, workingDate);

    if (result.reopened) {
      recordActivity({
        eventType: "REGION_EOD_REOPENED",
        actor: {
          id: currentUser.id,
          email: currentUser.email,
          role: currentUser.role,
        },
        regionId,
        targetType: "region_eod",
        targetId: result.state?.id ?? null,
        metadata: { workingDate },
        request,
      });
    }

    response.json({ data: result });
  },
);

export const getRegionEodStateController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireCurrentUser(request.currentUser);
    const workingDate = workingDateSchema.parse(request.params.date);

    response.json({ data: await getRegionEodState(workingDate) });
  },
);

export const getReportProductivityController: RequestHandler = asyncHandler(
  async (request, response) => {
    const currentUser = requireCurrentUser(request.currentUser);
    const workingDate = workingDateSchema.parse(request.params.date);

    response.json({
      data: await getReportProductivity(currentUser, workingDate),
    });
  },
);
