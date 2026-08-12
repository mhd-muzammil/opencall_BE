import { z } from "zod";
import type { Request, RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, forbidden } from "../utils/httpError.js";
import {
  createQuotation,
  findQuotationById,
  listQuotations,
} from "../repositories/quotationRepository.js";
import { autofillQuotation } from "../services/quotations/quotationAutofillService.js";
import { recordActivity } from "../services/audit/activityLogger.js";

/**
 * Resolves who is acting and enforces access. Regular users reach this behind the route's
 * role guard; a special-access credential must hold the "quotations" section.
 */
function requireQuotationAccess(request: Request): string {
  if (request.currentUser) {
    return request.currentUser.email ?? request.currentUser.username ?? "user";
  }
  if (request.specialAccess) {
    if (!request.specialAccess.sections.includes("quotations")) {
      throw forbidden("Quotations is not granted to this credential");
    }
    return `special-access:${request.specialAccess.username}`;
  }
  throw forbidden("Authentication required");
}

export const autofillQuotationController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireQuotationAccess(request);
    const caseId = String(request.query.caseId ?? "").trim();
    const orderNumber = String(request.query.orderNumber ?? "").trim();
    if (!caseId && !orderNumber) {
      throw badRequest("Provide a Case ID or Order Number");
    }
    const data = await autofillQuotation({ caseId, orderNumber });
    response.json({ data });
  },
);

const createSchema = z.object({
  quotationDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  caseId: z.string().trim().max(100).optional().default(""),
  orderNumber: z.string().trim().max(100).optional().default(""),
  customerName: z.string().trim().max(300).optional().default(""),
  customerAddress: z.string().trim().max(1000).optional().default(""),
  customerCity: z.string().trim().max(200).optional().default(""),
  customerState: z.string().trim().max(200).optional().default(""),
  customerPincode: z.string().trim().max(20).optional().default(""),
  customerPhone: z.string().trim().max(50).optional().default(""),
  customerEmail: z.string().trim().max(300).optional().default(""),
  // --- Line items ---
  // `lineItems` is what the form sends. The four flat fields and `baseAmount` below are
  // the pre-053 single-item shape, kept so an older client (or a saved integration) still
  // works; they are normalised into a one-element list right after parsing.
  lineItems: z
    .array(
      z.object({
        serviceDescription: z.string().trim().max(1000).optional().default(""),
        productDescription: z.string().trim().max(1000).optional().default(""),
        modelNo: z.string().trim().max(200).optional().default(""),
        serialNo: z.string().trim().max(200).optional().default(""),
        baseAmount: z.number().nonnegative().max(100000000),
      }),
    )
    // A quotation with a hundred rows is a data-entry accident, not a quotation.
    .max(50)
    .optional(),
  serviceDescription: z.string().trim().max(1000).optional().default(""),
  productDescription: z.string().trim().max(1000).optional().default(""),
  modelNo: z.string().trim().max(200).optional().default(""),
  serialNo: z.string().trim().max(200).optional().default(""),
  baseAmount: z.number().nonnegative().max(100000000).optional(),
  sgstPercent: z.number().min(0).max(100).optional().default(9),
  cgstPercent: z.number().min(0).max(100).optional().default(9),
});

export const createQuotationController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireQuotationAccess(request);
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("Invalid quotation", parsed.error.flatten());
    }

    const {
      lineItems,
      serviceDescription,
      productDescription,
      modelNo,
      serialNo,
      baseAmount,
      ...rest
    } = parsed.data;

    // One shape from here on. A pre-053 caller sending the flat fields becomes a
    // one-item quotation, which is exactly what it always was.
    const items =
      lineItems && lineItems.length > 0
        ? lineItems
        : [
            {
              serviceDescription,
              productDescription,
              modelNo,
              serialNo,
              baseAmount: baseAmount ?? 0,
            },
          ];

    // The sheet is priced work; a quotation of nothing is a mistake worth refusing rather
    // than issuing a running number for.
    if (items.every((item) => item.baseAmount <= 0)) {
      throw badRequest("Enter an amount greater than 0 on at least one line item");
    }

    const quotation = await createQuotation({
      ...rest,
      lineItems: items,
      createdBy: actor,
    });

    recordActivity({
      eventType: "UPLOAD_CREATED",
      actorEmailFallback: actor,
      ...(request.currentUser
        ? {
            actor: {
              id: request.currentUser.id,
              email: request.currentUser.email,
              role: request.currentUser.role,
            },
            regionId: request.currentUser.regionId ?? null,
          }
        : {}),
      targetType: "quotation",
      targetId: quotation.id,
      metadata: {
        kind: "QUOTATION_CREATED",
        quotationNo: quotation.quotationNo,
        caseId: quotation.caseId,
      },
      request,
    });

    response.status(201).json({ data: quotation });
  },
);

export const listQuotationsController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireQuotationAccess(request);
    const search = String(request.query.search ?? "").trim();
    const page = Number(request.query.page ?? 1);
    const perPage = Number(request.query.per_page ?? 30);
    const result = await listQuotations({
      search,
      page: Number.isFinite(page) ? page : 1,
      perPage: Number.isFinite(perPage) ? perPage : 30,
    });
    response.json({ data: result });
  },
);

export const getQuotationController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireQuotationAccess(request);
    const id = request.params.id?.trim();
    if (!id) {
      throw badRequest("Missing quotation id");
    }
    const quotation = await findQuotationById(id);
    if (!quotation) {
      throw badRequest("Quotation not found");
    }
    response.json({ data: quotation });
  },
);
