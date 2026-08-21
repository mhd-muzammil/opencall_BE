import { z } from "zod";
import type { Request, RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, forbidden, notFound, unprocessableEntity } from "../utils/httpError.js";
import { findAllowedRegionsForUser } from "../services/rbac/regionAccessService.js";
import { sendComposedEmail } from "../services/inboundEmail/composeService.js";
import {
  quotationMailHtml,
  quotationMailText,
  quotationSubject,
} from "../services/quotations/quotationMailer.js";
import {
  createQuotation,
  findQuotationById,
  listQuotations,
  updateQuotation,
  markQuotationSent,
  setQuotationPayment,
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

/**
 * The create and edit bodies are the same body — the edit form is the create form with the
 * values already in it — so they parse against the same schema and normalise the same way.
 * Returns the priced rows, or throws the same refusals the create path throws.
 */
function readQuotationBody(body: unknown): {
  rest: Omit<z.infer<typeof createSchema>, "lineItems" | "serviceDescription" | "productDescription" | "modelNo" | "serialNo" | "baseAmount">;
  items: { serviceDescription: string; productDescription: string; modelNo: string; serialNo: string; baseAmount: number }[];
} {
  const parsed = createSchema.safeParse(body);
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

  return { rest, items };
}

export const createQuotationController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireQuotationAccess(request);
    const { rest, items } = readQuotationBody(request.body);

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

/**
 * Correct an existing quotation.
 *
 * The running number is not reissued and `created_by` is left alone — this replaces the
 * contents of a sheet that already exists, it does not raise a new one. A 404 rather than
 * a silent success when the id is unknown, so a stale tab cannot look like it saved.
 */
export const updateQuotationController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireQuotationAccess(request);
    const id = String(request.params.id ?? "").trim();
    if (!id) throw badRequest("Missing quotation id");

    const { rest, items } = readQuotationBody(request.body);

    const quotation = await updateQuotation(id, {
      ...rest,
      lineItems: items,
      updatedBy: actor,
    });
    if (!quotation) throw notFound("Quotation not found", { id });

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
        kind: "QUOTATION_UPDATED",
        quotationNo: quotation.quotationNo,
        caseId: quotation.caseId,
      },
      request,
    });

    response.json({ data: quotation });
  },
);

/**
 * Mail the quotation to the customer, through the region mailbox Customer Emails uses.
 *
 * Deliberately the same send path as Compose: one place that puts mail on the wire, one
 * audit row in `outbound_emails`, one copy filed in the mailbox's own Sent folder. A
 * separate sender here would be a second thing to keep honest.
 *
 * The record is stamped only AFTER the mail has gone, so a failed send leaves the quotation
 * reading "not sent" rather than claiming a delivery that never happened.
 */
const sendSchema = z.object({
  regionCode: z.string().trim().min(1, "Choose which mailbox to send from"),
  to: z.string().trim().max(300).optional().default(""),
  note: z.string().trim().max(2000).optional().default(""),
});

export const sendQuotationController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireQuotationAccess(request);
    const id = String(request.params.id ?? "").trim();
    if (!id) throw badRequest("Missing quotation id");

    const parsed = sendSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw badRequest("Invalid send request", parsed.error.flatten());
    }

    const quotation = await findQuotationById(id);
    if (!quotation) throw notFound("Quotation not found", { id });

    // The address on the quotation unless the sender overrides it — a customer who gave a
    // different address for billing should not need the sheet edited to be mailed.
    const to = (parsed.data.to || quotation.customerEmail).trim();
    if (!to) {
      throw unprocessableEntity(
        "This quotation has no customer email. Add one with Edit, or type an address to send to.",
      );
    }

    // Region scope is enforced inside the send path itself, against the server's own
    // mailbox list — the region named here cannot widen what this login may send as.
    const regions = request.currentUser
      ? await findAllowedRegionsForUser(request.currentUser)
      : null;
    const allowedRegionCodes =
      regions === null ? null : regions.map((r) => r.name.trim().toUpperCase());

    const note = parsed.data.note.trim();
    const text = note
      ? `${note}\n\n${quotationMailText(quotation)}`
      : quotationMailText(quotation);
    const html = note
      ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;">${note
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br>")}</p>${quotationMailHtml(quotation)}`
      : quotationMailHtml(quotation);

    await sendComposedEmail({
      regionCode: parsed.data.regionCode,
      to,
      cc: "",
      subject: quotationSubject(quotation),
      body: text,
      bodyHtml: html,
      inReplyToId: null,
      attachments: [],
      allowedRegionCodes,
      sentByUserId: request.currentUser?.id ?? "",
    });

    const sent = await markQuotationSent({ id, sentTo: to, sentBy: actor });
    if (!sent) throw notFound("Quotation not found", { id });

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
      targetId: sent.id,
      metadata: {
        kind: "QUOTATION_SENT",
        quotationNo: sent.quotationNo,
        to,
        sendCount: sent.sendCount,
      },
      request,
    });

    response.json({ data: sent });
  },
);

/**
 * Record what the customer did about a quotation.
 *
 * A human's call, not something read out of a reply. Customers answer with a screenshot of
 * a transfer, a part payment, a question or a refusal, and inferring intent from that would
 * eventually mark an unpaid quotation paid — the one error here that costs money. The reply
 * is surfaced next to the quotation; the decision is made by the person looking at it.
 */
const paymentSchema = z.object({
  status: z.enum(["PENDING", "PAID", "DECLINED"]),
  note: z.string().trim().max(2000).optional().default(""),
});

export const setQuotationPaymentController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireQuotationAccess(request);
    const id = String(request.params.id ?? "").trim();
    if (!id) throw badRequest("Missing quotation id");

    const parsed = paymentSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw badRequest("Invalid payment update", parsed.error.flatten());
    }

    const updated = await setQuotationPayment({
      id,
      status: parsed.data.status,
      note: parsed.data.note,
      actor,
    });
    if (!updated) throw notFound("Quotation not found", { id });

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
      targetId: updated.id,
      metadata: {
        kind: "QUOTATION_PAYMENT",
        quotationNo: updated.quotationNo,
        status: updated.paymentStatus,
      },
      request,
    });

    response.json({ data: updated });
  },
);
