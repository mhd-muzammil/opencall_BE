import type { RequestHandler } from "express";
import { z } from "zod";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import { getRcaTimeline, listRcaCases } from "../services/rca/rcaService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";

const listQuerySchema = z.object({
  regionId: z.string().uuid().optional(),
  status: z.enum(["all", "stale", "critical", "active"]).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const timelineParamsSchema = z.object({
  ticketId: z.string().trim().min(1).max(200),
});

export const listRcaCasesController: RequestHandler = asyncHandler(
  async (request, response) => {
    const user = requireCurrentUser(request.currentUser);
    const filters = listQuerySchema.parse(request.query);
    const result = await listRcaCases(user, {
      regionId: filters.regionId ?? null,
      status: filters.status ?? "all",
      search: filters.search ?? null,
      ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
      ...(filters.offset !== undefined ? { offset: filters.offset } : {}),
    });
    response.json({ data: result });
  },
);

export const getRcaTimelineController: RequestHandler = asyncHandler(
  async (request, response) => {
    const user = requireCurrentUser(request.currentUser);
    const params = timelineParamsSchema.parse(request.params);
    const ticketKey = params.ticketId.trim().toUpperCase();
    if (!ticketKey) {
      throw badRequest("Ticket id is required");
    }
    const timeline = await getRcaTimeline(user, ticketKey);
    if (!timeline) {
      throw badRequest("Case was not found", { ticketId: params.ticketId });
    }
    response.json({ data: timeline });
  },
);
