import type { Request, RequestHandler, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveQuotationDraftController,
  listQuotationDraftsController,
  removeQuotationDraftController,
} from "./quotationController.js";
import { errorHandler } from "../middlewares/errorHandler.js";

/**
 * Quotations waiting for approval: listing them, approving one into a numbered quotation, and
 * removing one for good — through the real repository, against a stand-in database.
 */

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  recordActivity: vi.fn(),
}));

vi.mock("../config/database.js", () => ({
  query: mocks.query,
  pool: { connect: mocks.connect },
}));

vi.mock("../services/audit/activityLogger.js", () => ({
  recordActivity: mocks.recordActivity,
}));

const SUPER_ADMIN = {
  currentUser: {
    id: "user-1",
    email: "office@renderways.in",
    username: "office",
    role: "SUPER_ADMIN",
    regionId: null,
  },
};

type Row = Record<string, unknown>;

const VISIT_ID = "0b6f3b0e-1d2c-4c6e-9a51-000000000001";
const PART_ID = "0b6f3b0e-1d2c-4c6e-9a51-000000000002";
const UNKNOWN_ID = "0b6f3b0e-1d2c-4c6e-9a51-0000000000ff";

let drafts: Row[];
let quotations: Row[];
let counters: Map<string, number>;

function draftRow(overrides: Row): Row {
  return {
    kind: "VISIT",
    ticket_key: "WO036404653",
    ticket_id: "WO-036404653",
    case_id: "5166159539",
    flex_status: "Visit Estimate",
    work_location: "VELLORE",
    customer_name: "Likhitha",
    customer_address: "12, Gandhi Road",
    customer_city: "Vellore",
    customer_state: "Tamil Nadu",
    customer_pincode: "632001",
    customer_phone: "9000000002",
    customer_email: "likhitha@example.com",
    product_description: "HP Smart Tank 581 All-in-One Printer",
    model_no: "4A8D4A",
    serial_no: "CN43F65KWK",
    part: "",
    status: "WAITING",
    created_at: "2026-10-29 15:45:00+05:30",
    decided_at: null,
    decided_by: null,
    quotation_id: null,
    ...overrides,
  };
}

function squash(sql: unknown): string {
  return String(sql).replace(/\s+/g, " ").trim();
}

/** The WO the way the repository compares it: upper-case A-Z and 0-9 only. */
const key = (wo: unknown) => String(wo ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Every statement the approval's transaction issued, in order, by what it does. */
function steps(): string[] {
  return mocks.clientQuery.mock.calls.map(([sql]) => {
    const text = squash(sql);
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return text;
    if (text.includes("FROM quotation_drafts WHERE id = $1 FOR UPDATE")) return "LOCK DRAFT";
    if (text.startsWith("SELECT q.quotation_no FROM quotations q")) return "ALREADY RAISED?";
    if (/^INSERT INTO quotation_(visit_)?sequences/.test(text)) return "TAKE NUMBER";
    if (text.startsWith("INSERT INTO quotations (")) return "INSERT QUOTATION";
    if (text.startsWith("INSERT INTO quotation_line_items")) return "INSERT ITEM";
    if (text.startsWith("UPDATE quotation_drafts SET status = 'APPROVED'")) return "MARK APPROVED";
    return text;
  });
}

async function fakeClientQuery(sql: string, params: unknown[] = []) {
  const text = squash(sql);
  if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };

  if (text.includes("FROM quotation_drafts WHERE id = $1 FOR UPDATE")) {
    return { rows: drafts.filter((d) => d.id === params[0]) };
  }
  if (text.startsWith("SELECT q.quotation_no FROM quotations q")) {
    expect(text).toContain("regexp_replace(UPPER(q.order_number), '[^A-Z0-9]', '', 'g') = $2");
    const found = quotations.filter((q) => q.kind === params[0] && key(q.order_number) === params[1]);
    return { rows: found.slice(0, 1).map((q) => ({ quotation_no: q.quotation_no })) };
  }
  const sequence = /^INSERT INTO (quotation_sequences|quotation_visit_sequences) /.exec(text);
  if (sequence) {
    const k = `${sequence[1]}:${String(params[0])}`;
    const next = (counters.get(k) ?? 0) + 1;
    counters.set(k, next);
    return { rows: [{ last_seq: next }] };
  }
  if (text.startsWith("INSERT INTO quotations (")) {
    const p = params;
    const row: Row = {
      id: `q-${quotations.length + 1}`,
      quotation_no: p[0],
      quotation_date: p[1],
      case_id: p[2],
      order_number: p[3],
      customer_name: p[4],
      customer_email: p[10],
      base_amount: String(p[15]),
      sgst_percent: String(p[16]),
      cgst_percent: String(p[17]),
      created_by: p[18],
      kind: p[19],
      created_at: "2026-10-29 16:00:00+05:30",
    };
    quotations.push(row);
    return { rows: [row] };
  }
  if (text.startsWith("INSERT INTO quotation_line_items")) return { rows: [] };
  if (text.startsWith("UPDATE quotation_drafts SET status = 'APPROVED'")) {
    const draft = drafts.find((d) => d.id === params[0])!;
    Object.assign(draft, { status: "APPROVED", decided_by: params[1], quotation_id: params[2] });
    return { rows: [draft] };
  }
  throw new Error(`fake db: unexpected SQL: ${text}`);
}

async function fakeQuery(sql: string, params: unknown[] = []) {
  const text = squash(sql);
  if (text.startsWith("UPDATE quotation_drafts SET status = 'REMOVED'")) {
    expect(text).toContain("WHERE id = $1 AND status = 'WAITING'");
    const draft = drafts.find((d) => d.id === params[0] && d.status === "WAITING");
    if (!draft) return { rows: [] };
    Object.assign(draft, { status: "REMOVED", decided_by: params[1] });
    return { rows: [draft] };
  }
  if (text.includes("FROM quotation_drafts WHERE id = $1")) {
    return { rows: drafts.filter((d) => d.id === params[0]) };
  }
  if (text.includes("FROM quotation_drafts d WHERE")) {
    // Only the waiting ones, none whose WO has a quotation of the kind already, and only the
    // ones the newest report still has at their status. That last part is the report's to
    // answer, and is checked on a real database; here every waiting one is still current.
    expect(text).toContain("d.status = 'WAITING'");
    expect(text).toContain("NOT EXISTS ( SELECT 1 FROM quotations q WHERE q.kind = d.kind");
    expect(text).toMatch(/^WITH latest AS \( SELECT r\.id, r\.report_date FROM report_history_sessions s/);
    expect(text).toContain(
      "EXISTS (SELECT 1 FROM current_calls cc WHERE cc.kind = d.kind AND cc.ticket_key = d.ticket_key)",
    );
    const kind = text.includes("d.kind = $1") ? params[0] : null;
    const rows = drafts.filter(
      (d) =>
        d.status === "WAITING" &&
        (!kind || d.kind === kind) &&
        !quotations.some((q) => q.kind === d.kind && key(q.order_number) === d.ticket_key),
    );
    if (text.includes("SELECT COUNT(*)::TEXT AS count FROM quotation_drafts d")) {
      return { rows: [{ count: String(rows.length) }] };
    }
    return { rows };
  }
  throw new Error(`fake db: unexpected SQL: ${text}`);
}

interface Answer {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error: { code: string; message: string; details: unknown } | undefined;
}

function call(handler: RequestHandler, request: object): Promise<Answer> {
  return new Promise((resolve) => {
    let status = 200;
    const response = {
      status(code: number) {
        status = code;
        return response;
      },
      json(body: { data?: unknown; error?: Answer["error"] }) {
        resolve({ status, data: body.data, error: body.error });
        return response;
      },
    };
    const req = { params: {}, query: {}, ...request } as unknown as Request;
    const res = response as unknown as Response;
    handler(req, res, (error?: unknown) => errorHandler(error, req, res, () => undefined));
  });
}

/** The approval form as the page sends it: the waiting quotation's details, plus the amount. */
function approvalBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: "VISIT",
    quotationDate: "2026-10-29",
    caseId: "5166159539",
    orderNumber: "WO-036404653",
    customerName: "Likhitha",
    customerEmail: "likhitha@example.com",
    lineItems: [
      {
        serviceDescription: "",
        productDescription: "HP Smart Tank 581 All-in-One Printer",
        modelNo: "4A8D4A",
        serialNo: "CN43F65KWK",
        baseAmount: 550,
      },
    ],
    sgstPercent: 9,
    cgstPercent: 9,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  drafts = [
    draftRow({ id: VISIT_ID }),
    draftRow({
      id: PART_ID,
      kind: "PART",
      ticket_key: "WO036403359",
      ticket_id: "WO-036403359",
      flex_status: "Visit Quote To Customer",
    }),
  ];
  quotations = [];
  counters = new Map();
  mocks.query.mockImplementation(fakeQuery);
  mocks.clientQuery.mockImplementation(fakeClientQuery);
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
});

describe("listing the quotations waiting for approval", () => {
  it("lists one kind's waiting quotations", async () => {
    const answer = await call(listQuotationDraftsController, { ...SUPER_ADMIN, query: { kind: "visit" } });

    expect(answer.status).toBe(200);
    expect(answer.data.total).toBe(1);
    expect(answer.data.items.map((d: { ticketId: string }) => d.ticketId)).toEqual(["WO-036404653"]);
    expect(answer.data.items[0]).toMatchObject({ kind: "VISIT", status: "WAITING", quotationId: null });
  });

  it("refuses a kind that is neither", async () => {
    const answer = await call(listQuotationDraftsController, { ...SUPER_ADMIN, query: { kind: "repair" } });

    expect(answer.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("is closed to a special-access login without Quotations", async () => {
    const answer = await call(listQuotationDraftsController, {
      specialAccess: { username: "branch", sections: ["records"] },
    });

    expect(answer.status).toBe(403);
  });
});

describe("approving one", () => {
  it("raises the quotation with the next number of its kind, and marks it approved, in one transaction", async () => {
    const answer = await call(approveQuotationDraftController, {
      ...SUPER_ADMIN,
      params: { id: VISIT_ID },
      body: approvalBody(),
    });

    expect(answer.status).toBe(201);
    expect(answer.data).toMatchObject({ quotationNo: "RTPL/26-27/QEV/1", kind: "VISIT", orderNumber: "WO-036404653" });
    expect(steps()).toEqual([
      "BEGIN",
      "LOCK DRAFT",
      "ALREADY RAISED?",
      "TAKE NUMBER",
      "INSERT QUOTATION",
      "INSERT ITEM",
      "MARK APPROVED",
      "COMMIT",
    ]);
    expect(drafts[0]).toMatchObject({
      status: "APPROVED",
      decided_by: "office@renderways.in",
      quotation_id: "q-1",
    });
    expect(mocks.recordActivity.mock.calls[0]![0].metadata).toMatchObject({
      kind: "QUOTATION_CREATED",
      quotationNo: "RTPL/26-27/QEV/1",
      approvedFrom: VISIT_ID,
    });
  });

  it("approves a Visit Estimate as a Visit quotation whatever kind the form names", async () => {
    const answer = await call(approveQuotationDraftController, {
      ...SUPER_ADMIN,
      params: { id: VISIT_ID },
      body: approvalBody({ kind: "PART" }),
    });

    expect(answer.data.quotationNo).toBe("RTPL/26-27/QEV/1");
    expect(answer.data.kind).toBe("VISIT");
  });

  it("raises it for its own work order whatever WO the form names", async () => {
    // An auto-fill by case can bring back a sibling work order on the same case.
    const answer = await call(approveQuotationDraftController, {
      ...SUPER_ADMIN,
      params: { id: VISIT_ID },
      body: approvalBody({ orderNumber: "WO-036404999" }),
    });

    expect(answer.status).toBe(201);
    expect(answer.data.orderNumber).toBe("WO-036404653");
    expect(quotations[0]!.order_number).toBe("WO-036404653");
  });

  it("numbers a Part one on the QEN series", async () => {
    const answer = await call(approveQuotationDraftController, {
      ...SUPER_ADMIN,
      params: { id: PART_ID },
      body: approvalBody({ orderNumber: "WO-036403359", lineItems: [{ serviceDescription: "Top cover", baseAmount: 1800 }] }),
    });

    expect(answer.data.quotationNo).toBe("RTPL/26-27/QEN/1");
    expect(answer.data.kind).toBe("PART");
  });

  it("will not approve without an amount, and touches nothing", async () => {
    const answer = await call(approveQuotationDraftController, {
      ...SUPER_ADMIN,
      params: { id: VISIT_ID },
      body: approvalBody({ lineItems: [{ productDescription: "Printer", baseAmount: 0 }] }),
    });

    expect(answer.status).toBe(400);
    expect(answer.error?.message).toBe("Enter an amount greater than 0 on at least one line item");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(drafts[0]!.status).toBe("WAITING");
  });

  it("tells the second click it is already approved, without taking another number", async () => {
    await call(approveQuotationDraftController, { ...SUPER_ADMIN, params: { id: VISIT_ID }, body: approvalBody() });
    mocks.clientQuery.mockClear();

    const again = await call(approveQuotationDraftController, {
      ...SUPER_ADMIN,
      params: { id: VISIT_ID },
      body: approvalBody(),
    });

    expect(again.status).toBe(409);
    expect(again.error?.message).toBe("The quotation for WO-036404653 has already been approved.");
    expect(steps()).toEqual(["BEGIN", "LOCK DRAFT", "ROLLBACK"]);
    expect(quotations).toHaveLength(1);
  });

  it("refuses when the work order got a quotation of its kind while it waited", async () => {
    // Raised by hand, its WO typed with a space instead of the dash.
    quotations.push({ kind: "VISIT", order_number: "wo 036404653", quotation_no: "RTPL/26-27/QEV/5" });

    const answer = await call(approveQuotationDraftController, {
      ...SUPER_ADMIN,
      params: { id: VISIT_ID },
      body: approvalBody(),
    });

    expect(answer.status).toBe(409);
    expect(answer.error?.message).toBe("WO-036404653 already has RTPL/26-27/QEV/5. Remove this one instead.");
    expect(steps()).toEqual(["BEGIN", "LOCK DRAFT", "ALREADY RAISED?", "ROLLBACK"]);
    expect(counters.size).toBe(0);
  });

  it("answers 404 for an id that is not a waiting quotation", async () => {
    const unknown = await call(approveQuotationDraftController, {
      ...SUPER_ADMIN,
      params: { id: UNKNOWN_ID },
      body: approvalBody(),
    });
    const notAnId = await call(approveQuotationDraftController, {
      ...SUPER_ADMIN,
      params: { id: "drafts" },
      body: approvalBody(),
    });

    expect(unknown.status).toBe(404);
    expect(notAnId.status).toBe(404);
    // Refused before Postgres could be asked to read "drafts" as a UUID.
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });
});

describe("removing one", () => {
  it("takes it off the list for good", async () => {
    const answer = await call(removeQuotationDraftController, { ...SUPER_ADMIN, params: { id: VISIT_ID } });

    expect(answer.status).toBe(200);
    expect(answer.data).toMatchObject({ status: "REMOVED", decidedBy: "office@renderways.in" });
    const list = await call(listQuotationDraftsController, { ...SUPER_ADMIN, query: { kind: "VISIT" } });
    expect(list.data.total).toBe(0);
    expect(mocks.recordActivity.mock.calls[0]![0].metadata).toMatchObject({
      kind: "QUOTATION_DRAFT_REMOVED",
      ticketId: "WO-036404653",
    });
  });

  it("says so when it was already removed, or approved", async () => {
    await call(removeQuotationDraftController, { ...SUPER_ADMIN, params: { id: VISIT_ID } });
    const again = await call(removeQuotationDraftController, { ...SUPER_ADMIN, params: { id: VISIT_ID } });
    await call(approveQuotationDraftController, {
      ...SUPER_ADMIN,
      params: { id: PART_ID },
      body: approvalBody({ orderNumber: "WO-036403359" }),
    });
    const approved = await call(removeQuotationDraftController, { ...SUPER_ADMIN, params: { id: PART_ID } });

    expect(again.status).toBe(409);
    expect(again.error?.message).toBe("The quotation for WO-036404653 has already been removed.");
    expect(approved.status).toBe(409);
    expect(approved.error?.message).toBe("The quotation for WO-036403359 has already been approved.");
  });

  it("answers 404 for an unknown one", async () => {
    const answer = await call(removeQuotationDraftController, { ...SUPER_ADMIN, params: { id: UNKNOWN_ID } });

    expect(answer.status).toBe(404);
  });
});
