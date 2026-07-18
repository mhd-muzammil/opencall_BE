import type { Request, Response, RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";
import {
  createEngineerService,
  getEngineersDropdownService,
  listEngineersService,
  setEngineerActiveService,
  updateEngineerService,
} from "../services/engineers/engineerService.js";

export const getEngineersDropdownController: RequestHandler = asyncHandler(
  async (request, response) => {
    const regionId = request.query.regionId as string | undefined;
    const engineers = await getEngineersDropdownService(request.currentUser!, regionId);
    response.json({ data: { engineers } });
  },
);

export const listAdminEngineersController: RequestHandler = asyncHandler(
  async (request, response) => {
    const limit = Number(request.query.limit) || 100;
    const offset = Number(request.query.offset) || 0;
    const regionId = request.query.regionId as string | undefined;
    const search = request.query.search as string | undefined;
    const isActive = request.query.isActive !== undefined ? request.query.isActive === "true" : undefined;

    const filters: any = { limit, offset };
    if (regionId !== undefined) filters.regionId = regionId;
    if (search !== undefined) filters.search = search;
    if (isActive !== undefined) filters.isActive = isActive;

    const result = await listEngineersService(request.currentUser!, filters);

    response.json({ data: result });
  },
);

export const createAdminEngineerController: RequestHandler = asyncHandler(
  async (request, response) => {
    const { engineerName, engineerCode, regionId, email, phone, hpId, vendorId } =
      request.body;

    if (!engineerName || typeof engineerName !== "string") {
      throw badRequest("engineerName is required");
    }
    if (!regionId || typeof regionId !== "string") {
      throw badRequest("regionId is required");
    }

    const engineer = await createEngineerService(request.currentUser!, {
      engineerName,
      engineerCode,
      regionId,
      email,
      phone,
      ...(typeof hpId === "string" ? { hpId } : {}),
      ...(typeof vendorId === "string" ? { vendorId } : {}),
    });

    response.status(201).json({ data: { engineer } });
  },
);

export const updateAdminEngineerController: RequestHandler = asyncHandler(
  async (request, response) => {
    const { id } = request.params;
    if (!id) {
      throw badRequest("id is required");
    }

    const engineer = await updateEngineerService(request.currentUser!, id, request.body);
    response.json({ data: { engineer } });
  },
);

export const deactivateAdminEngineerController: RequestHandler = asyncHandler(
  async (request, response) => {
    const { id } = request.params;
    if (!id) {
      throw badRequest("id is required");
    }

    const engineer = await setEngineerActiveService(request.currentUser!, id, false);
    response.json({ data: { engineer } });
  },
);

export const reactivateAdminEngineerController: RequestHandler = asyncHandler(
  async (request, response) => {
    const { id } = request.params;
    if (!id) {
      throw badRequest("id is required");
    }

    const engineer = await setEngineerActiveService(request.currentUser!, id, true);
    response.json({ data: { engineer } });
  },
);
