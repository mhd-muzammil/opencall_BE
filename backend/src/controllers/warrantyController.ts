import type { RequestHandler } from "express";
import {
  requireCurrentUser,
  resolveEffectiveRegionId,
} from "../services/rbac/regionAccessService.js";
import {
  buildWarrantyJobFile,
  createWarrantyJob,
  getWarrantyJob,
  retryWarrantyJob,
} from "../services/warranty/warrantyJobService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";
import { warrantyJobIdParamSchema } from "../validators/warrantyJobValidators.js";

const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const createWarrantyJobController: RequestHandler = asyncHandler(
  async (request, response) => {
    const currentUser = requireCurrentUser(request.currentUser);
    const regionId = await resolveEffectiveRegionId(
      currentUser,
      request.header("x-region-id") ?? request.body?.regionId ?? null,
    );

    const file = request.file;
    if (!file) {
      throw badRequest("A Flex WIP .xlsx file is required on the 'file' field");
    }

    const job = await createWarrantyJob({
      originalFileName: file.originalname,
      storedFilePath: file.path,
      createdBy: currentUser.id,
      regionId,
    });

    response.status(201).json({ data: job });
  },
);

export const getWarrantyJobController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireCurrentUser(request.currentUser);
    const { id } = warrantyJobIdParamSchema.parse(request.params);

    const job = await getWarrantyJob(id);

    response.json({ data: job });
  },
);

export const retryWarrantyJobController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireCurrentUser(request.currentUser);
    const { id } = warrantyJobIdParamSchema.parse(request.params);

    const job = await retryWarrantyJob(id);

    response.json({ data: job });
  },
);

/** Streams the generated workbook. 409 while the job still has queued work. */
export const downloadWarrantyJobFileController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireCurrentUser(request.currentUser);
    const { id } = warrantyJobIdParamSchema.parse(request.params);

    const file = await buildWarrantyJobFile(id);

    response.setHeader("Content-Type", XLSX_CONTENT_TYPE);
    response.download(file.filePath, file.fileName);
  },
);
