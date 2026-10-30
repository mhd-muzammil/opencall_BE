import { z } from "zod";
import type { Request, RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, conflict, forbidden, notFound, unprocessableEntity } from "../utils/httpError.js";
import { findAllowedRegionsForUser } from "../services/rbac/regionAccessService.js";
import { sendComposedEmail } from "../services/inboundEmail/composeService.js";
import {
  DESK_MAIL_FROM_MAILBOX,
  deskMailAttachmentName,
  deskMailHtml,
  deskMailInlineImages,
  deskMailSubject,
  deskMailText,
} from "../services/quotations/tradeDeskMail.js";
import { deskMailRecipients } from "../services/quotations/tradeDeskRecipients.js";
import { quotationMessageId } from "../services/quotations/quotationMessageId.js";
import {
  createQuotation,
  findQuotationById,
  listQuotations,
  updateQuotation,
  markQuotationSent,
  setQuotationPayment,
  type QuotationKind,
} from "../repositories/quotationRepository.js";
import {
  approveQuotationDraft,
  listQuotationDrafts,
  removeQuotationDraft,
} from "../repositories/quotationDraftRepository.js";
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
  // Which sheet, and so which number series. No default HERE: this schema also parses an
  // edit, and an edit keeps the kind the quotation was raised as, the way it keeps its
  // number. The create path defaults it to PART, which is what every older client means.
  kind: z.enum(["PART", "VISIT"]).optional(),
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
 *
 * `kind` comes back apart from `rest`, so only the create path can pass it on: an edit that
 * spread `rest` into the update could otherwise turn a Visit quotation into a Part one.
 */
function readQuotationBody(body: unknown): {
  rest: Omit<z.infer<typeof createSchema>, "kind" | "lineItems" | "serviceDescription" | "productDescription" | "modelNo" | "serialNo" | "baseAmount">;
  items: { serviceDescription: string; productDescription: string; modelNo: string; serialNo: string; baseAmount: number }[];
  kind: QuotationKind;
} {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid quotation", parsed.error.flatten());
  }

  const {
    kind,
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

  return { rest, items, kind: kind ?? "PART" };
}

export const createQuotationController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireQuotationAccess(request);
    const { rest, items, kind } = readQuotationBody(request.body);

    const quotation = await createQuotation({
      ...rest,
      kind,
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

/** An optional ISO moment from the query string, refused rather than guessed when unreadable. */
function readMoment(value: unknown, name: string): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const time = Date.parse(text);
  if (text.length > 40 || Number.isNaN(time)) {
    throw badRequest(`${name} must be an ISO date and time`);
  }
  return new Date(time).toISOString();
}

export const listQuotationsController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireQuotationAccess(request);
    const search = String(request.query.search ?? "").trim();
    // The Visit and Part tabs each ask for their own kind. No kind means both, as before.
    const kind = String(request.query.kind ?? "").trim().toUpperCase();
    if (kind && kind !== "PART" && kind !== "VISIT") {
      throw badRequest("kind must be PART or VISIT");
    }
    // When it was raised, so the page can keep the quotations from before its fresh start
    // apart (its History) and out of its count boxes.
    const createdFrom = readMoment(request.query.created_from, "created_from");
    const createdBefore = readMoment(request.query.created_before, "created_before");
    const page = Number(request.query.page ?? 1);
    const perPage = Number(request.query.per_page ?? 30);
    const result = await listQuotations({
      search,
      ...(kind ? { kind: kind as QuotationKind } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(createdBefore ? { createdBefore } : {}),
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
 * Mail the quotation to the customer as the trade desk's own mail, from trade@renderways.in.
 *
 * Deliberately the same send path as Compose: one place that puts mail on the wire, one
 * audit row in `outbound_emails`, one copy filed in the mailbox's own Sent folder. A
 * separate sender here would be a second thing to keep honest.
 *
 * The record is stamped only AFTER the mail has gone, so a failed send leaves the quotation
 * reading "not sent" rather than claiming a delivery that never happened.
 */
const sendSchema = z.object({
  // Ignored: every quotation leaves from the trade desk. Accepted so a page that still names
  // a mailbox is not refused for it.
  regionCode: z.string().trim().max(100).optional(),
  to: z.string().trim().max(300).optional().default(""),
  // Who is copied, as the sender left it in the dialog. Absent — a page from before the
  // field existed — means the desk's own list (deskMailRecipients).
  cc: z.string().trim().max(2000).optional(),
  note: z.string().trim().max(2000).optional().default(""),
  // Which version of the quotation the attached sheet was drawn from — its updatedAt, or
  // createdAt while it has never been edited. See sendQuotationController.
  renderedVersion: z.string().trim().max(100).optional(),
});

/**
 * The access check, as a middleware, for a route that must refuse BEFORE it reads a body:
 * the send route takes an upload, and a login with no business here should be turned away
 * before megabytes of it are held in memory, not after.
 */
export const requireQuotationAccessMiddleware: RequestHandler = (request, _response, next) => {
  try {
    requireQuotationAccess(request);
    next();
  } catch (error) {
    next(error);
  }
};

/** The region names this login may send as; null when unrestricted (Super Admin). */
async function allowedRegionCodesFor(request: Request): Promise<string[] | null> {
  const regions = request.currentUser ? await findAllowedRegionsForUser(request.currentUser) : null;
  return regions === null ? null : regions.map((r) => r.name.trim().toUpperCase());
}

/**
 * Why this login may not send a quotation, or null when it may.
 *
 * Every quotation leaves from the trade desk, and the send path lets a login write only as
 * the mailboxes of its own regions. A branch login owns its branch's mailbox, not the desk's.
 * Said up front, in words, rather than as "no access to that region's mailbox" for a mailbox
 * nobody chose.
 */
function deskSendBlockedReason(allowedRegionCodes: readonly string[] | null): string | null {
  if (allowedRegionCodes === null || allowedRegionCodes.includes(DESK_MAIL_FROM_MAILBOX)) {
    return null;
  }
  return "Quotations go out from trade@renderways.in, and only a Super Admin can send from it.";
}

/**
 * The estimate the sender's browser attached: the quotation's sheet as a PDF.
 *
 * Required. The mail says "Kindly make the payment as per attached estimate", and the amount
 * is in the estimate and nowhere else — sent without it, the customer is asked to pay a
 * figure nobody gave them. A page loaded before this existed attaches nothing, and is told to
 * reload rather than that mail going out. Recognised by its content, not by the name or type
 * the browser claims for it.
 */
function readEstimatePdf(request: Request): Buffer {
  const files = Array.isArray(request.files) ? request.files : [];
  const pdf = files.find((file) => file.buffer.subarray(0, 5).toString("latin1") === "%PDF-");
  if (!pdf) {
    throw unprocessableEntity(
      "The quotation PDF did not come with this send. Reload the page (Ctrl+Shift+R) and send again.",
    );
  }
  return pdf.buffer;
}

/**
 * What sending this quotation will put on the wire: where from, the subject, who is copied,
 * what is attached — and whether this login may send it at all. The Send dialog shows it
 * before anything goes, and the send itself asks the same functions, so the dialog cannot
 * promise one mail and the server send another.
 */
export const quotationSendDefaultsController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireQuotationAccess(request);
    const id = String(request.params.id ?? "").trim();
    if (!id) throw badRequest("Missing quotation id");

    const quotation = await findQuotationById(id);
    if (!quotation) throw notFound("Quotation not found", { id });

    const blockedReason = deskSendBlockedReason(await allowedRegionCodesFor(request));
    const { from, branch, cc } = await deskMailRecipients(quotation.id);
    response.json({
      data: {
        kind: quotation.kind,
        from,
        subject: deskMailSubject(quotation),
        cc,
        branch,
        attachmentName: deskMailAttachmentName(quotation),
        canSend: blockedReason === null,
        blockedReason,
      },
    });
  },
);

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
    // mailbox list — nothing in the request can widen what this login may send as.
    const allowedRegionCodes = await allowedRegionCodesFor(request);
    const blocked = deskSendBlockedReason(allowedRegionCodes);
    if (blocked) throw forbidden(blocked);

    // The sheet is drawn in the sender's browser from the quotation as that page had it. An
    // edit made elsewhere since — another tab, another person — would put the old figures in
    // the PDF and the new ones everywhere else in the mail, so the version it was drawn from
    // must be the version on file.
    const onFile = quotation.updatedAt ?? quotation.createdAt;
    if (!parsed.data.renderedVersion) {
      throw unprocessableEntity("This page is out of date. Reload it (Ctrl+Shift+R) and send again.");
    }
    if (parsed.data.renderedVersion !== onFile) {
      throw conflict("This quotation was changed while the PDF was being made. Send it again.");
    }

    // Asked for before the CC is looked up, so a send without the sheet stops there.
    const estimate = readEstimatePdf(request);

    const note = parsed.data.note.trim();
    const noteHtml = note
      ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;">${note
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br>")}</p>`
      : "";
    const cc = parsed.data.cc ?? (await deskMailRecipients(quotation.id)).cc.join(", ");

    await sendComposedEmail({
      regionCode: DESK_MAIL_FROM_MAILBOX,
      to,
      cc,
      subject: deskMailSubject(quotation),
      body: note ? `${note}\n\n${deskMailText(quotation)}` : deskMailText(quotation),
      bodyHtml: `${noteHtml}${deskMailHtml(quotation)}`,
      inReplyToId: null,
      attachments: [
        {
          filename: deskMailAttachmentName(quotation),
          mimeType: "application/pdf",
          content: estimate,
        },
      ],
      inlineImages: deskMailInlineImages(),
      // Names the quotation, so the Sent-folder check can tell this mail from another
      // quotation's now that the subject carries no quotation number.
      messageId: quotationMessageId(quotation.id),
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
        ...(cc ? { cc } : {}),
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

// --- Waiting for approval -----------------------------------------------------------------
//
// Quotations the OpenCall report raised on its own (quotationDraftDetector): a 01-Trade work
// order at Visit Estimate waits as a Visit quotation, one at Visit Quote To Customer as a Part
// one. They have no number and no amount until somebody approves them here.

/** A waiting quotation's id is a UUID; anything else would reach Postgres as a cast error. */
const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readDraftId(request: Request): string {
  const id = String(request.params.id ?? "").trim();
  if (!DRAFT_ID.test(id)) throw notFound("Waiting quotation not found", { id });
  return id;
}

/** Why a second Approve or Remove did nothing, in the words of the list it came from. */
function decidedMessage(draft: { ticketId: string; status: string }): string {
  return draft.status === "APPROVED"
    ? `The quotation for ${draft.ticketId} has already been approved.`
    : `The quotation for ${draft.ticketId} has already been removed.`;
}

export const listQuotationDraftsController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireQuotationAccess(request);
    const search = String(request.query.search ?? "").trim();
    const kind = String(request.query.kind ?? "").trim().toUpperCase();
    if (kind && kind !== "PART" && kind !== "VISIT") {
      throw badRequest("kind must be PART or VISIT");
    }
    const result = await listQuotationDrafts({
      search,
      ...(kind ? { kind: kind as QuotationKind } : {}),
    });
    response.json({ data: result });
  },
);

/**
 * Approve a waiting quotation: the body is the quotation form, the same as creating one, and
 * the quotation it raises takes the next number of the waiting one's kind. The kind in the
 * body is ignored — a Visit Estimate is approved as a Visit quotation whatever the form says.
 */
export const approveQuotationDraftController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireQuotationAccess(request);
    const id = readDraftId(request);
    const { rest, items } = readQuotationBody(request.body);

    const result = await approveQuotationDraft(id, {
      ...rest,
      lineItems: items,
      createdBy: actor,
    });
    if (result.outcome === "NOT_FOUND") {
      throw notFound("Waiting quotation not found", { id });
    }
    if (result.outcome === "DECIDED") {
      throw conflict(decidedMessage(result.draft));
    }
    if (result.outcome === "ALREADY_RAISED") {
      throw conflict(
        `${result.draft.ticketId} already has ${result.quotationNo}. Remove this one instead.`,
      );
    }

    const { quotation } = result;
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
        approvedFrom: id,
      },
      request,
    });

    response.status(201).json({ data: quotation });
  },
);

/** Take a waiting quotation off the list. It stays recorded, so no report raises it again. */
export const removeQuotationDraftController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireQuotationAccess(request);
    const id = readDraftId(request);

    const result = await removeQuotationDraft(id, actor);
    if (result.outcome === "NOT_FOUND") {
      throw notFound("Waiting quotation not found", { id });
    }
    if (result.outcome === "DECIDED") {
      throw conflict(decidedMessage(result.draft));
    }

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
      targetId: result.draft.id,
      metadata: {
        kind: "QUOTATION_DRAFT_REMOVED",
        quotationKind: result.draft.kind,
        ticketId: result.draft.ticketId,
        caseId: result.draft.caseId,
      },
      request,
    });

    response.json({ data: result.draft });
  },
);
