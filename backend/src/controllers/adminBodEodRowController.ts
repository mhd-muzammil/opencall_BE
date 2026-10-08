import type { RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";
import {
  createBodEodCustomRowService,
  deleteBodEodCustomRowService,
  listBodEodCustomRowsService,
  updateBodEodCustomRowService,
} from "../services/rtplStatuses/bodEodCustomRowService.js";

// Custom BOD/EOD rows, managed beside the RTPL statuses (SUPER_ADMIN only).

export const listAdminBodEodRowsController: RequestHandler = asyncHandler(
  async (_request, response) => {
    const rows = await listBodEodCustomRowsService();
    response.json({ data: { rows } });
  },
);

export const createAdminBodEodRowController: RequestHandler = asyncHandler(
  async (request, response) => {
    const { label, productivityBucket, afterRow } = request.body ?? {};
    const row = await createBodEodCustomRowService(request.currentUser!, {
      label,
      productivityBucket,
      afterRow,
    });
    response.status(201).json({ data: { row } });
  },
);

export const updateAdminBodEodRowController: RequestHandler = asyncHandler(
  async (request, response) => {
    const { id } = request.params;
    if (!id) throw badRequest("id is required");
    const { label, productivityBucket, afterRow, sortOrder, isActive } = request.body ?? {};
    const row = await updateBodEodCustomRowService(request.currentUser!, id, {
      label,
      productivityBucket,
      afterRow,
      sortOrder,
      isActive,
    });
    response.json({ data: { row } });
  },
);

export const deleteAdminBodEodRowController: RequestHandler = asyncHandler(
  async (request, response) => {
    const { id } = request.params;
    if (!id) throw badRequest("id is required");
    await deleteBodEodCustomRowService(request.currentUser!, id);
    response.json({ data: { success: true } });
  },
);
