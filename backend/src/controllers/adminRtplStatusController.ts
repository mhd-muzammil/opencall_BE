import type { RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";
import {
  createRtplStatusService,
  deleteRtplStatusService,
  getRtplStatusesDropdownService,
  listRtplStatusesService,
  setRtplStatusActiveService,
  updateRtplStatusService,
} from "../services/rtplStatuses/rtplStatusService.js";

export const getRtplStatusesDropdownController: RequestHandler = asyncHandler(
  async (_request, response) => {
    const statuses = await getRtplStatusesDropdownService();
    response.json({ data: { statuses } });
  },
);

export const listAdminRtplStatusesController: RequestHandler = asyncHandler(
  async (request, response) => {
    const category = request.query.category as string | undefined;
    const search = request.query.search as string | undefined;
    const isActive =
      request.query.isActive !== undefined ? request.query.isActive === "true" : undefined;

    const filters: Parameters<typeof listRtplStatusesService>[0] = {};
    if (category !== undefined) filters.category = category;
    if (search !== undefined) filters.search = search;
    if (isActive !== undefined) filters.isActive = isActive;

    const statuses = await listRtplStatusesService(filters);
    response.json({ data: { statuses } });
  },
);

export const createAdminRtplStatusController: RequestHandler = asyncHandler(
  async (request, response) => {
    const { name, category, sortOrder } = request.body;

    if (!name || typeof name !== "string") {
      throw badRequest("name is required");
    }

    const input: Parameters<typeof createRtplStatusService>[1] = { name };
    if (category !== undefined) input.category = category;
    if (typeof sortOrder === "number") input.sortOrder = sortOrder;

    const status = await createRtplStatusService(request.currentUser!, input);

    response.status(201).json({ data: { status } });
  },
);

export const updateAdminRtplStatusController: RequestHandler = asyncHandler(
  async (request, response) => {
    const { id } = request.params;
    if (!id) {
      throw badRequest("id is required");
    }

    const { status, renamedRowValues } = await updateRtplStatusService(
      request.currentUser!,
      id,
      request.body,
    );
    response.json({ data: { status, renamedRowValues } });
  },
);

export const deactivateAdminRtplStatusController: RequestHandler = asyncHandler(
  async (request, response) => {
    const { id } = request.params;
    if (!id) {
      throw badRequest("id is required");
    }

    const status = await setRtplStatusActiveService(request.currentUser!, id, false);
    response.json({ data: { status } });
  },
);

export const reactivateAdminRtplStatusController: RequestHandler = asyncHandler(
  async (request, response) => {
    const { id } = request.params;
    if (!id) {
      throw badRequest("id is required");
    }

    const status = await setRtplStatusActiveService(request.currentUser!, id, true);
    response.json({ data: { status } });
  },
);

export const deleteAdminRtplStatusController: RequestHandler = asyncHandler(
  async (request, response) => {
    const { id } = request.params;
    if (!id) {
      throw badRequest("id is required");
    }

    await deleteRtplStatusService(request.currentUser!, id);
    response.json({ data: { success: true } });
  },
);
