import { z } from "zod";
import type { Request, RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { HttpError, badRequest, forbidden, notFound } from "../utils/httpError.js";
import {
  CHALLAN_BRANCH_KEYS,
  createDeliveryChallan,
  findDeliveryChallanById,
  isChallanBranchKey,
  isDeliveryChallanSchemaMissing,
  listChallanBranches,
  listDeliveryChallans,
  saveChallanBranch,
  updateDeliveryChallan,
  type ChallanBranchKey,
} from "../repositories/deliveryChallanRepository.js";
import { autofillDeliveryChallan } from "../services/deliveryChallans/deliveryChallanAutofillService.js";
import {
  recordActivity,
  type RecordActivityInput,
} from "../services/audit/activityLogger.js";

/** The section a special-access credential must hold. */
const SECTION_KEY = "delivery-challans";

/**
 * What every endpoint answers (503) while migration 070 is unapplied. The deploy does not
 * wait for the migration, so this code can be live before its tables are — which has to
 * read as "not set up yet, here is the command", never as a crash.
 */
export const DELIVERY_CHALLAN_NOT_SET_UP =
  "Delivery Challan is not set up yet: run npm run migrate:delivery-challans";

/**
 * Resolves who is acting and enforces access: a SUPER_ADMIN, or a special-access
 * credential holding the "delivery-challans" section. Region admins and vendor logins are
 * refused — the sidebar shows the section to neither.
 */
function requireDeliveryChallanAccess(request: Request): string {
  if (request.currentUser) {
    if (request.currentUser.role !== "SUPER_ADMIN") {
      throw forbidden("Delivery Challan is open to super admins only");
    }
    return request.currentUser.email ?? request.currentUser.username ?? "user";
  }
  if (request.specialAccess) {
    if (!request.specialAccess.sections.includes(SECTION_KEY)) {
      throw forbidden("Delivery Challan is not granted to this credential");
    }
    return `special-access:${request.specialAccess.username}`;
  }
  if (request.vendorAccess) {
    throw forbidden("Delivery Challan is not available to vendor logins");
  }
  throw forbidden("Authentication required");
}

/**
 * Branch letterheads print on every challan raised from then on, so only a super admin
 * may change them — not a special-access credential, even one holding the section.
 */
function requireBranchEditor(request: Request): string {
  const user = request.currentUser;
  if (!user || user.role !== "SUPER_ADMIN") {
    throw forbidden("Only a super admin can edit branch details");
  }
  return user.email ?? user.username ?? "user";
}

/** Runs work against the delivery-challan tables, answering 503 while they do not exist. */
async function withChallanTables<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isDeliveryChallanSchemaMissing(error)) {
      throw new HttpError(503, DELIVERY_CHALLAN_NOT_SET_UP);
    }
    throw error;
  }
}

/** The activity-log actor: a regular user is recorded in full, anyone else by label. */
function activityActor(request: Request): Pick<RecordActivityInput, "actor" | "regionId"> {
  if (!request.currentUser) return {};
  return {
    actor: {
      id: request.currentUser.id,
      email: request.currentUser.email,
      role: request.currentUser.role,
    },
    regionId: request.currentUser.regionId ?? null,
  };
}

/**
 * A challan id is a BIGSERIAL. Anything else cannot name a challan, and must not reach
 * the SQL as a bigint (Postgres would answer 500 for "abc").
 */
function readChallanId(request: Request): string {
  const id = String(request.params.id ?? "").trim();
  if (!/^[1-9]\d{0,17}$/.test(id)) {
    throw notFound("Delivery challan not found", { id });
  }
  return id;
}

/** A real calendar day in a plausible range: "2026-02-30" or "0226-10-07" is a typo. */
function isChallanDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2099) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** One-line text: trimmed, capped, blank when absent. */
const text = (max: number) => z.string().trim().max(max).optional().default("");

/** Newline-separated text (one case / product / address line each), with \r\n made \n. */
const lines = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value.replace(/\r\n?/g, "\n"))
    .optional()
    .default("");

const itemSchema = z.object({
  description: text(1000),
  hsnSac: text(50),
  qty: text(20),
  rate: text(50),
  per: text(20),
});

const challanSchema = z.object({
  branchKey: z.enum(CHALLAN_BRANCH_KEYS, {
    errorMap: () => ({ message: `Branch must be one of: ${CHALLAN_BRANCH_KEYS.join(", ")}` }),
  }),
  challanDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .refine(isChallanDate, "Date must be a real date between 2000 and 2099"),
  customerName: text(300),
  customerPhone: text(100),
  customerEmail: text(300),
  customerAddress: lines(2000),
  caseIds: lines(2000),
  productSerials: lines(2000),
  productNumbers: lines(2000),
  productNames: lines(4000),
  refNoDate: text(300),
  modeTerms: text(300),
  otherReferences: lines(1000),
  // A challan of more rows than this is a data-entry accident, not a delivery.
  items: z.array(itemSchema).max(50, "A delivery challan takes at most 50 rows").optional().default([]),
});

/** The create and edit bodies are the same body, so they parse the same way. */
function readChallanBody(body: unknown): z.infer<typeof challanSchema> {
  const parsed = challanSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid delivery challan", parsed.error.flatten());
  }
  return parsed.data;
}

const branchSchema = z.object({
  name: z.string().trim().min(1, "Branch name is required").max(100),
  companyLine: text(300),
  addressLines: lines(1000),
  gstin: text(30),
  contact: text(200),
  email: text(300),
});

export const autofillDeliveryChallanController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireDeliveryChallanAccess(request);
    const caseId = String(request.query.caseId ?? "").trim();
    const orderNumber = String(request.query.orderNumber ?? "").trim();
    if (!caseId && !orderNumber) {
      throw badRequest("Provide a Case ID or Order Number");
    }
    const data = await autofillDeliveryChallan({ caseId, orderNumber });
    if (!data) {
      throw notFound("No matching case found. You can fill the details in by hand.", {
        caseId,
        orderNumber,
      });
    }
    response.json({ data });
  },
);

export const listDeliveryChallansController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireDeliveryChallanAccess(request);
    const search = String(request.query.search ?? "").trim();

    const branch = String(request.query.branch ?? "").trim().toLowerCase();
    let branchKey: ChallanBranchKey | null = null;
    if (branch && branch !== "all") {
      if (!isChallanBranchKey(branch)) {
        throw badRequest("Unknown branch", { branch, branches: CHALLAN_BRANCH_KEYS });
      }
      branchKey = branch;
    }

    const page = Number(request.query.page ?? 1);
    const pageSize = Number(request.query.pageSize ?? request.query.per_page ?? 30);
    const result = await withChallanTables(() =>
      listDeliveryChallans({
        search,
        branchKey,
        page: Number.isFinite(page) ? page : 1,
        perPage: Number.isFinite(pageSize) ? pageSize : 30,
      }),
    );
    response.json({ data: result });
  },
);

export const getDeliveryChallanController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireDeliveryChallanAccess(request);
    const id = readChallanId(request);
    const challan = await withChallanTables(() => findDeliveryChallanById(id));
    if (!challan) throw notFound("Delivery challan not found", { id });
    response.json({ data: challan });
  },
);

export const createDeliveryChallanController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireDeliveryChallanAccess(request);
    const body = readChallanBody(request.body);

    const challan = await withChallanTables(() =>
      createDeliveryChallan({ ...body, createdBy: actor }),
    );
    if (!challan) {
      // A valid branch with no row: its seed is missing. Re-running the migration puts it
      // back (ON CONFLICT DO NOTHING leaves the other branches alone). Nothing was numbered.
      throw new HttpError(503, DELIVERY_CHALLAN_NOT_SET_UP, { branchKey: body.branchKey });
    }

    recordActivity({
      eventType: "UPLOAD_CREATED",
      actorEmailFallback: actor,
      ...activityActor(request),
      targetType: "delivery_challan",
      targetId: challan.id,
      metadata: {
        kind: "DELIVERY_CHALLAN_CREATED",
        branchKey: challan.branchKey,
        finYear: challan.finYear,
        dcSeq: challan.dcSeq,
        caseIds: challan.caseIds,
      },
      request,
    });

    response.status(201).json({ data: challan });
  },
);

/**
 * Correct an existing challan.
 *
 * The number, branch and financial year are fixed once issued: a body naming another
 * branch, or a date in another financial year, is refused with 400 rather than quietly
 * renumbered. A 404 when the id is unknown, so a stale tab cannot look like it saved.
 */
export const updateDeliveryChallanController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireDeliveryChallanAccess(request);
    const id = readChallanId(request);
    const body = readChallanBody(request.body);

    const result = await withChallanTables(() =>
      updateDeliveryChallan(id, { ...body, updatedBy: actor }),
    );
    switch (result.status) {
      case "not_found":
        throw notFound("Delivery challan not found", { id });
      case "branch_locked":
        throw badRequest(
          `A delivery challan's branch cannot be changed: DC No. ${result.dcSeq} (${result.finYear}) was issued by ${result.branchKey}`,
          { branchKey: result.branchKey, finYear: result.finYear, dcSeq: result.dcSeq },
        );
      case "fin_year_locked":
        throw badRequest(
          `The date must stay within the financial year ${result.finYear}: DC No. ${result.dcSeq} is numbered in that year`,
          { branchKey: result.branchKey, finYear: result.finYear, dcSeq: result.dcSeq },
        );
    }
    const challan = result.challan;

    recordActivity({
      eventType: "UPLOAD_CREATED",
      actorEmailFallback: actor,
      ...activityActor(request),
      targetType: "delivery_challan",
      targetId: challan.id,
      metadata: {
        kind: "DELIVERY_CHALLAN_UPDATED",
        branchKey: challan.branchKey,
        finYear: challan.finYear,
        dcSeq: challan.dcSeq,
        caseIds: challan.caseIds,
      },
      request,
    });

    response.json({ data: challan });
  },
);

export const listChallanBranchesController: RequestHandler = asyncHandler(
  async (request, response) => {
    requireDeliveryChallanAccess(request);
    const branches = await withChallanTables(() => listChallanBranches());
    response.json({ data: branches });
  },
);

/**
 * Edit one branch's letterhead. Only challans raised AFTER this print the new text: every
 * challan already issued carries its own copy of the header it was raised with.
 */
export const updateChallanBranchController: RequestHandler = asyncHandler(
  async (request, response) => {
    const actor = requireBranchEditor(request);
    const branchKey = String(request.params.key ?? "").trim().toLowerCase();
    if (!isChallanBranchKey(branchKey)) {
      throw notFound("Unknown branch", { branchKey, branches: CHALLAN_BRANCH_KEYS });
    }

    const parsed = branchSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("Invalid branch details", parsed.error.flatten());
    }

    const branch = await withChallanTables(() =>
      saveChallanBranch(branchKey, parsed.data, actor),
    );

    recordActivity({
      eventType: "UPLOAD_CREATED",
      actorEmailFallback: actor,
      ...activityActor(request),
      targetType: "delivery_challan",
      targetId: branchKey,
      metadata: {
        kind: "DELIVERY_CHALLAN_BRANCH_UPDATED",
        branchKey,
        name: branch.name,
      },
      request,
    });

    response.json({ data: branch });
  },
);
