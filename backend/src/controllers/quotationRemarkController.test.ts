import type { Request, RequestHandler, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listQuotationRemarksController,
  setQuotationDraftRemarkController,
  setQuotationRemarkController,
} from "./quotationController.js";
import { quotationRouter } from "../routes/quotationRoutes.js";
import { errorHandler } from "../middlewares/errorHandler.js";

/**
 * The Quotations table's Remark column (the user, 5 Nov 2026): a line typed against a quotation
 * or a waiting one — through the real repository, against a stand-in database.
 */

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
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

const Q1 = "6d1c1e2a-7b3f-4a51-9c0d-000000000001";
const Q2 = "6d1c1e2a-7b3f-4a51-9c0d-000000000002";
const Q3 = "6d1c1e2a-7b3f-4a51-9c0d-000000000003";
const D_WAITING = "0b6f3b0e-1d2c-4c6e-9a51-000000000001";
const D_APPROVED = "0b6f3b0e-1d2c-4c6e-9a51-000000000002";
const D_REMOVED = "0b6f3b0e-1d2c-4c6e-9a51-000000000003";
const D_APPROVED_2 = "0b6f3b0e-1d2c-4c6e-9a51-000000000004";
const UNKNOWN = "0b6f3b0e-1d2c-4c6e-9a51-0000000000ff";

type Remark = {
  quotation_id: string | null;
  draft_id: string | null;
  remark: string;
  updated_at: string;
  updated_by: string;
};
type Quotation = { id: string; kind: string; order_number: string; created_at: string };
type Draft = {
  id: string;
  kind: string;
  ticket_key: string;
  ticket_id: string;
  status: string;
  quotation_id: string | null;
};

let quotations: Quotation[];
let drafts: Draft[];
let remarks: Remark[];
let clock: number;

/** The WO the way the repository compares it: upper-case A-Z and 0-9 only. */
const key = (wo: string) => wo.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The quotation raised for a waiting one: the one approving it raised, else the first of its kind for its WO. */
function raisedInto(draft: Draft | undefined): string | null {
  if (!draft) return null;
  if (draft.quotation_id) return draft.quotation_id;
  const mine = quotations
    .filter((q) => q.kind === draft.kind && key(q.order_number) === draft.ticket_key)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return mine[0]?.id ?? null;
}

function squash(sql: unknown): string {
  return String(sql).replace(/\s+/g, " ").trim();
}

function stamp(): string {
  clock += 1;
  return `2026-11-05 15:${String(clock).padStart(2, "0")}:00+05:30`;
}

const returned = (r: Remark) => ({ ...r });

/** What Postgres does with the three statements the repository issues. */
async function fakeQuery(sql: string, params: unknown[] = []) {
  const text = squash(sql);

  if (text.startsWith("SELECT r.quotation_id::TEXT AS quotation_id")) {
    expect(text).toContain("FROM quotation_remarks r LEFT JOIN quotation_drafts d ON d.id = r.draft_id");
    // The approval's quotation, else the waiting list's own rule for "already quoted".
    expect(text).toContain(
      "COALESCE(d.quotation_id, ( SELECT q.id FROM quotations q WHERE q.kind = d.kind AND regexp_replace(UPPER(q.order_number), '[^A-Z0-9]', '', 'g') = d.ticket_key ORDER BY q.created_at LIMIT 1 ))::TEXT AS raised_into",
    );
    return {
      rows: remarks.map((r) => ({
        ...r,
        raised_into: r.draft_id ? raisedInto(drafts.find((d) => d.id === r.draft_id)) : null,
      })),
    };
  }

  if (text.startsWith("INSERT INTO quotation_remarks (quotation_id, remark, updated_by)")) {
    // Only for a quotation that exists, and one row per quotation, replaced in place.
    expect(text).toContain("FROM quotations q WHERE q.id = $1::uuid");
    expect(text).toContain("ON CONFLICT (quotation_id) DO UPDATE");
    const [id, remark, by] = params as [string, string, string];
    if (!quotations.some((q) => q.id === id)) return { rows: [] };
    let row = remarks.find((r) => r.quotation_id === id);
    if (row) Object.assign(row, { remark, updated_by: by, updated_at: stamp() });
    else {
      row = { quotation_id: id, draft_id: null, remark, updated_by: by, updated_at: stamp() };
      remarks.push(row);
    }
    return { rows: [returned(row)] };
  }

  if (text.startsWith("INSERT INTO quotation_remarks (draft_id, remark, updated_by)")) {
    // Only while it waits.
    expect(text).toContain("FROM quotation_drafts d WHERE d.id = $1::uuid AND d.status = 'WAITING'");
    expect(text).toContain("ON CONFLICT (draft_id) DO UPDATE");
    const [id, remark, by] = params as [string, string, string];
    if (!drafts.some((d) => d.id === id && d.status === "WAITING")) return { rows: [] };
    let row = remarks.find((r) => r.draft_id === id);
    if (row) Object.assign(row, { remark, updated_by: by, updated_at: stamp() });
    else {
      row = { quotation_id: null, draft_id: id, remark, updated_by: by, updated_at: stamp() };
      remarks.push(row);
    }
    return { rows: [returned(row)] };
  }

  if (text === "SELECT ticket_id, status FROM quotation_drafts WHERE id = $1::uuid") {
    return { rows: drafts.filter((d) => d.id === params[0]) };
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

/** Every statement issued, squashed, for checks on what was (and was not) touched. */
const statements = () => mocks.query.mock.calls.map(([sql]) => squash(sql));

beforeEach(() => {
  vi.clearAllMocks();
  clock = 0;
  quotations = [
    { id: Q1, kind: "VISIT", order_number: "WO-036400001", created_at: "2026-11-01 10:00:00+05:30" },
    { id: Q2, kind: "VISIT", order_number: "WO-036482331", created_at: "2026-11-02 10:00:00+05:30" },
    { id: Q3, kind: "PART", order_number: "WO-036499999", created_at: "2026-11-03 10:00:00+05:30" },
  ];
  drafts = [
    { id: D_WAITING, kind: "VISIT", ticket_key: "WO036475541", ticket_id: "WO-036475541", status: "WAITING", quotation_id: null },
    { id: D_APPROVED, kind: "VISIT", ticket_key: "WO036482331", ticket_id: "WO-036482331", status: "APPROVED", quotation_id: Q2 },
    { id: D_REMOVED, kind: "VISIT", ticket_key: "WO036472983", ticket_id: "WO-036472983", status: "REMOVED", quotation_id: null },
    { id: D_APPROVED_2, kind: "VISIT", ticket_key: "WO036400001", ticket_id: "WO-036400001", status: "APPROVED", quotation_id: Q1 },
  ];
  remarks = [];
  mocks.query.mockImplementation(fakeQuery);
});

describe("listing remarks", () => {
  it("gives every remark by quotation and by waiting quotation", async () => {
    remarks = [
      { quotation_id: Q3, draft_id: null, remark: "Will pay on Monday", updated_at: "t1", updated_by: "office" },
      { quotation_id: null, draft_id: D_WAITING, remark: "Called twice, no answer", updated_at: "t2", updated_by: "office" },
    ];

    const answer = await call(listQuotationRemarksController, SUPER_ADMIN);

    expect(answer.status).toBe(200);
    expect(answer.data).toEqual({
      quotations: { [Q3]: { remark: "Will pay on Monday", updatedAt: "t1", updatedBy: "office" } },
      drafts: { [D_WAITING]: { remark: "Called twice, no answer", updatedAt: "t2", updatedBy: "office" } },
    });
  });

  it("shows a waiting one's remark on the quotation approving it raised", async () => {
    remarks = [
      { quotation_id: null, draft_id: D_APPROVED, remark: "Customer asked for a call first", updated_at: "t1", updated_by: "office" },
    ];

    const answer = await call(listQuotationRemarksController, SUPER_ADMIN);

    expect(answer.data.quotations[Q2]).toEqual({
      remark: "Customer asked for a call first",
      updatedAt: "t1",
      updatedBy: "office",
    });
  });

  it("shows a waiting one's remark on the quotation raised by hand for its WO — the first of its kind", async () => {
    const Q4 = "6d1c1e2a-7b3f-4a51-9c0d-000000000004";
    const Q5 = "6d1c1e2a-7b3f-4a51-9c0d-000000000005";
    const Q6 = "6d1c1e2a-7b3f-4a51-9c0d-000000000006";
    quotations.push(
      // Typed with spaces and lower case: the same WO the way the waiting list compares it.
      { id: Q4, kind: "VISIT", order_number: " wo-036475541 ", created_at: "2026-11-05 11:00:00+05:30" },
      // A second one for the same WO, raised later: not the one it goes on.
      { id: Q5, kind: "VISIT", order_number: "WO-036475541", created_at: "2026-11-05 12:00:00+05:30" },
      // A Part quotation for the same WO: another kind, so not raised for this waiting one.
      { id: Q6, kind: "PART", order_number: "WO-036475541", created_at: "2026-11-05 10:00:00+05:30" },
    );
    remarks = [
      { quotation_id: null, draft_id: D_WAITING, remark: "Customer will call back Monday", updated_at: "t1", updated_by: "office" },
    ];

    const answer = await call(listQuotationRemarksController, SUPER_ADMIN);

    expect(answer.data.quotations[Q4]?.remark).toBe("Customer will call back Monday");
    expect(answer.data.quotations[Q5]).toBeUndefined();
    expect(answer.data.quotations[Q6]).toBeUndefined();
  });

  it("shows a removed one's remark on the quotation raised by hand for its WO", async () => {
    const Q4 = "6d1c1e2a-7b3f-4a51-9c0d-000000000004";
    quotations.push({ id: Q4, kind: "VISIT", order_number: "WO-036472983", created_at: "2026-11-05 11:00:00+05:30" });
    remarks = [
      { quotation_id: null, draft_id: D_REMOVED, remark: "Already quoted by the branch", updated_at: "t1", updated_by: "office" },
    ];

    const answer = await call(listQuotationRemarksController, SUPER_ADMIN);

    expect(answer.data.quotations[Q4]?.remark).toBe("Already quoted by the branch");
    expect(answer.data.drafts[D_REMOVED]?.remark).toBe("Already quoted by the branch");
  });

  it("keeps a quotation's own remark over the one it carried — even one cleared to nothing", async () => {
    remarks = [
      // Q1's own came first in the table here; Q2's own came after its waiting one's.
      { quotation_id: Q1, draft_id: null, remark: "Paid by cash", updated_at: "t3", updated_by: "office" },
      { quotation_id: null, draft_id: D_APPROVED_2, remark: "Old note", updated_at: "t1", updated_by: "office" },
      { quotation_id: null, draft_id: D_APPROVED, remark: "Customer asked for a call first", updated_at: "t2", updated_by: "office" },
      { quotation_id: Q2, draft_id: null, remark: "", updated_at: "t4", updated_by: "office" },
    ];

    const answer = await call(listQuotationRemarksController, SUPER_ADMIN);

    expect(answer.data.quotations[Q1].remark).toBe("Paid by cash");
    expect(answer.data.quotations[Q2].remark).toBe("");
  });

  it("answers an empty list when nobody has written one", async () => {
    const answer = await call(listQuotationRemarksController, SUPER_ADMIN);
    expect(answer.data).toEqual({ quotations: {}, drafts: {} });
  });

  it("keeps a special-access login without Quotations out", async () => {
    const answer = await call(listQuotationRemarksController, {
      specialAccess: { username: "branch-desk", sections: ["records"] },
    });
    expect(answer.status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("a quotation's remark", () => {
  it("is saved trimmed, as the person who typed it, and logged", async () => {
    const answer = await call(setQuotationRemarkController, {
      ...SUPER_ADMIN,
      params: { id: Q1 },
      body: { remark: "  Will pay on Monday  " },
    });

    expect(answer.status).toBe(200);
    expect(answer.data).toMatchObject({ remark: "Will pay on Monday", updatedBy: "office@renderways.in" });
    expect(remarks).toEqual([expect.objectContaining({ quotation_id: Q1, remark: "Will pay on Monday" })]);
    expect(mocks.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: "quotation",
        targetId: Q1,
        metadata: { kind: "QUOTATION_REMARK", remark: "Will pay on Monday" },
      }),
    );
  });

  it("replaces the one before it, and can be cleared", async () => {
    await call(setQuotationRemarkController, { ...SUPER_ADMIN, params: { id: Q1 }, body: { remark: "First" } });
    await call(setQuotationRemarkController, { ...SUPER_ADMIN, params: { id: Q1 }, body: { remark: "Second" } });
    expect(remarks.filter((r) => r.quotation_id === Q1).map((r) => r.remark)).toEqual(["Second"]);

    const cleared = await call(setQuotationRemarkController, { ...SUPER_ADMIN, params: { id: Q1 }, body: { remark: "   " } });
    expect(cleared.status).toBe(200);
    expect(cleared.data.remark).toBe("");
  });

  it("never touches the quotation itself, so its version — what a send checks — stays put", async () => {
    await call(setQuotationRemarkController, { ...SUPER_ADMIN, params: { id: Q1 }, body: { remark: "Note" } });
    expect(statements().some((sql) => /^UPDATE quotations\b/.test(sql))).toBe(false);
    expect(statements().every((sql) => sql.startsWith("INSERT INTO quotation_remarks"))).toBe(true);
  });

  it("answers 404 for a quotation that does not exist, and stores nothing", async () => {
    const answer = await call(setQuotationRemarkController, {
      ...SUPER_ADMIN,
      params: { id: UNKNOWN },
      body: { remark: "Note" },
    });
    expect(answer.status).toBe(404);
    expect(remarks).toEqual([]);
    expect(mocks.recordActivity).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that is not one, without asking the database", async () => {
    const answer = await call(setQuotationRemarkController, {
      ...SUPER_ADMIN,
      params: { id: "remarks" },
      body: { remark: "Note" },
    });
    expect(answer.status).toBe(404);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("refuses a remark that is too long, or not text", async () => {
    const long = await call(setQuotationRemarkController, {
      ...SUPER_ADMIN,
      params: { id: Q1 },
      body: { remark: "x".repeat(501) },
    });
    expect(long.status).toBe(400);
    const notText = await call(setQuotationRemarkController, {
      ...SUPER_ADMIN,
      params: { id: Q1 },
      body: { remark: 42 },
    });
    expect(notText.status).toBe(400);
    const none = await call(setQuotationRemarkController, { ...SUPER_ADMIN, params: { id: Q1 } });
    expect(none.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();

    const longest = await call(setQuotationRemarkController, {
      ...SUPER_ADMIN,
      params: { id: Q1 },
      body: { remark: "x".repeat(500) },
    });
    expect(longest.status).toBe(200);
  });

  it("keeps a special-access login without Quotations out", async () => {
    const answer = await call(setQuotationRemarkController, {
      specialAccess: { username: "branch-desk", sections: ["records"] },
      params: { id: Q1 },
      body: { remark: "Note" },
    });
    expect(answer.status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("is written as the special-access login that has Quotations", async () => {
    const answer = await call(setQuotationRemarkController, {
      specialAccess: { username: "trade-desk", sections: ["quotations"] },
      params: { id: Q1 },
      body: { remark: "Note" },
    });
    expect(answer.status).toBe(200);
    expect(answer.data.updatedBy).toBe("special-access:trade-desk");
  });
});

describe("a waiting quotation's remark", () => {
  it("is saved while it waits", async () => {
    const answer = await call(setQuotationDraftRemarkController, {
      ...SUPER_ADMIN,
      params: { id: D_WAITING },
      body: { remark: " Called twice, no answer " },
    });

    expect(answer.status).toBe(200);
    expect(answer.data).toMatchObject({ remark: "Called twice, no answer", updatedBy: "office@renderways.in" });
    expect(remarks).toEqual([expect.objectContaining({ draft_id: D_WAITING, remark: "Called twice, no answer" })]);
    expect(mocks.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { kind: "QUOTATION_DRAFT_REMARK", remark: "Called twice, no answer" } }),
    );
  });

  it("is refused once it has been approved or removed, saying which", async () => {
    const approved = await call(setQuotationDraftRemarkController, {
      ...SUPER_ADMIN,
      params: { id: D_APPROVED },
      body: { remark: "Note" },
    });
    expect(approved.status).toBe(409);
    expect(approved.error?.message).toBe("The quotation for WO-036482331 has already been approved.");

    const removed = await call(setQuotationDraftRemarkController, {
      ...SUPER_ADMIN,
      params: { id: D_REMOVED },
      body: { remark: "Note" },
    });
    expect(removed.status).toBe(409);
    expect(removed.error?.message).toBe("The quotation for WO-036472983 has already been removed.");
    expect(remarks).toEqual([]);
    expect(mocks.recordActivity).not.toHaveBeenCalled();
  });

  it("answers 404 for one that does not exist, or an id that is not one", async () => {
    const unknown = await call(setQuotationDraftRemarkController, {
      ...SUPER_ADMIN,
      params: { id: UNKNOWN },
      body: { remark: "Note" },
    });
    expect(unknown.status).toBe(404);
    mocks.query.mockClear();
    const malformed = await call(setQuotationDraftRemarkController, {
      ...SUPER_ADMIN,
      params: { id: "not-a-uuid" },
      body: { remark: "Note" },
    });
    expect(malformed.status).toBe(404);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("refuses a remark that is too long", async () => {
    const answer = await call(setQuotationDraftRemarkController, {
      ...SUPER_ADMIN,
      params: { id: D_WAITING },
      body: { remark: "x".repeat(501) },
    });
    expect(answer.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("routes", () => {
  it("declares GET /remarks before GET /:id, which would read it as a quotation id", () => {
    const stack = (quotationRouter as unknown as {
      stack: { route?: { path: string; methods: Record<string, boolean> } }[];
    }).stack;
    const routes = stack
      .filter((layer) => layer.route)
      .map((layer) => `${Object.keys(layer.route!.methods)[0]?.toUpperCase()} ${layer.route!.path}`);

    expect(routes).toContain("GET /remarks");
    expect(routes).toContain("PUT /drafts/:id/remark");
    expect(routes).toContain("PUT /:id/remark");
    expect(routes.indexOf("GET /remarks")).toBeLessThan(routes.indexOf("GET /:id"));
  });
});
