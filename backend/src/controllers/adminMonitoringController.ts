import type { RequestHandler } from "express";
import { z } from "zod";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import {
  buildMonitoringDashboard,
  buildRegionDrillDown,
} from "../services/audit/monitoringService.js";
import {
  listActivity,
  type ActivityEventType,
} from "../repositories/activityLogRepository.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, forbidden } from "../utils/httpError.js";

const ACTIVITY_EVENT_TYPES: readonly ActivityEventType[] = [
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "LOGOUT",
  "PASSWORD_CHANGED",
  "PASSWORD_RESET",
  "USER_CREATED",
  "USER_PROFILE_UPDATED",
  "USER_ROLE_CHANGED",
  "USER_REGION_REASSIGNED",
  "USER_DEACTIVATED",
  "USER_REACTIVATED",
  "UPLOAD_CREATED",
  "REPORT_GENERATED",
  "REPORT_ROW_EDITED",
];

const activityEventTypeSchema = z.enum(
  ACTIVITY_EVENT_TYPES as unknown as [ActivityEventType, ...ActivityEventType[]],
);

const dashboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const regionDrillQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const regionIdParamSchema = z.object({
  regionId: z.string().uuid(),
});

const activityQuerySchema = z.object({
  regionId: z.string().uuid().optional(),
  actorUserId: z.string().uuid().optional(),
  eventType: activityEventTypeSchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const getMonitoringDashboardController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireCurrentUser(request.currentUser);
    const filters = dashboardQuerySchema.parse(request.query);
    const dashboard = await buildMonitoringDashboard({
      ...(filters.limit !== undefined ? { recentLimit: filters.limit } : {}),
    });
    response.json({ data: dashboard });
  },
);

export const getRegionDrillDownController: RequestHandler = asyncHandler(
  async (request, response) => {
    const currentUser = requireCurrentUser(request.currentUser);
    const params = regionIdParamSchema.parse(request.params);
    if (
      currentUser.role === "REGION_ADMIN" &&
      currentUser.regionId !== params.regionId
    ) {
      throw forbidden("REGION_ADMIN cannot drill into another region", {
        requestedRegionId: params.regionId,
        userRegionId: currentUser.regionId,
      });
    }
    const filters = regionDrillQuerySchema.parse(request.query);
    const detail = await buildRegionDrillDown(params.regionId, {
      ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
    });
    if (!detail) {
      throw badRequest("Region was not found", {
        regionId: params.regionId,
      });
    }
    response.json({ data: detail });
  },
);

export const listAdminActivityController: RequestHandler = asyncHandler(
  async (request, response) => {
    const currentUser = requireCurrentUser(request.currentUser);
    const filters = activityQuerySchema.parse(request.query);
    let effectiveRegionId = filters.regionId;
    if (currentUser.role === "REGION_ADMIN") {
      if (!currentUser.regionId) {
        throw forbidden("REGION_ADMIN user is not assigned to a region");
      }
      if (filters.regionId && filters.regionId !== currentUser.regionId) {
        throw forbidden("REGION_ADMIN cannot view activity from another region");
      }
      effectiveRegionId = currentUser.regionId;
    }

    const result = await listActivity({
      ...(effectiveRegionId !== undefined ? { regionId: effectiveRegionId } : {}),
      ...(filters.actorUserId !== undefined ? { actorUserId: filters.actorUserId } : {}),
      ...(filters.eventType !== undefined ? { eventType: filters.eventType } : {}),
      ...(filters.from !== undefined ? { from: filters.from } : {}),
      ...(filters.to !== undefined ? { to: filters.to } : {}),
      ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
      ...(filters.offset !== undefined ? { offset: filters.offset } : {}),
    });
    response.json({ data: result });
  },
);
