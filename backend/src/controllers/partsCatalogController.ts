import fs from "node:fs";
import type { Request, RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, forbidden } from "../utils/httpError.js";
import {
  countCatalogParts,
  deleteAllCatalogParts,
  listCatalogParts,
} from "../repositories/partsCatalogRepository.js";
import { importPartsCatalogFromFile } from "../services/partsCatalog/partsCatalogImportService.js";
import { recordActivity } from "../services/audit/activityLogger.js";

/**
 * Read access to the Parts Catalog: any regular user (the section is gated in the UI /
 * routes), or a special-access credential that has been granted the "parts-catalog"
 * section. Returns a label for the audit log / editor check.
 */
function requirePartsReader(request: Request): string {
  if (request.currentUser) {
    return request.currentUser.email ?? request.currentUser.username ?? "user";
  }
  if (request.specialAccess) {
    if (!request.specialAccess.sections.includes("parts-catalog")) {
      throw forbidden("Parts Catalog is not granted to this credential");
    }
    return `special-access:${request.specialAccess.username}`;
  }
  throw forbidden("Authentication required");
}

export const listCatalogPartsController: RequestHandler = asyncHandler(
  async (request, response) => {
    requirePartsReader(request);
    const search = String(request.query.search ?? "").trim();
    const page = Number(request.query.page ?? 1);
    const perPage = Number(request.query.per_page ?? 50);

    const result = await listCatalogParts({
      search,
      page: Number.isFinite(page) ? page : 1,
      perPage: Number.isFinite(perPage) ? perPage : 50,
    });
    response.json({ data: result });
  },
);

export const importCatalogPartsController: RequestHandler = asyncHandler(
  async (request, response) => {
    // Import / delete are write actions — regular users only (route enforces SUPER_ADMIN).
    if (!request.currentUser) {
      throw forbidden("Only an administrator can import the parts catalog");
    }
    const actor = request.currentUser;
    const file = request.file;
    if (!file) {
      throw badRequest("No parts file was uploaded", { field: "file" });
    }

    try {
      const result = await importPartsCatalogFromFile(file.path);
      recordActivity({
        eventType: "UPLOAD_CREATED",
        actor: { id: actor.id, email: actor.email, role: actor.role },
        regionId: actor.regionId ?? null,
        targetType: "parts_catalog",
        metadata: {
          kind: "PARTS_CATALOG_IMPORT",
          originalFileName: file.originalname,
          ...result,
        },
        request,
      });
      response.status(201).json({ data: result });
    } finally {
      fs.promises.unlink(file.path).catch(() => {
        /* best-effort cleanup */
      });
    }
  },
);

export const deleteAllCatalogPartsController: RequestHandler = asyncHandler(
  async (request, response) => {
    if (!request.currentUser) {
      throw forbidden("Only an administrator can clear the parts catalog");
    }
    const deleted = await deleteAllCatalogParts();
    recordActivity({
      eventType: "UPLOAD_CREATED",
      actor: {
        id: request.currentUser.id,
        email: request.currentUser.email,
        role: request.currentUser.role,
      },
      regionId: request.currentUser.regionId ?? null,
      targetType: "parts_catalog",
      metadata: { kind: "PARTS_CATALOG_DELETE_ALL", deleted },
      request,
    });
    response.json({ data: { deleted } });
  },
);

export const catalogPartsStatusController: RequestHandler = asyncHandler(
  async (request, response) => {
    requirePartsReader(request);
    const count = await countCatalogParts();
    response.json({ data: { count } });
  },
);
