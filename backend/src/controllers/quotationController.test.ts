import type { Request, RequestHandler, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createQuotationController,
  listQuotationsController,
  updateQuotationController,
} from "./quotationController.js";
import { errorHandler } from "../middlewares/errorHandler.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  recordActivity: vi.fn(),
}));

// The database is a stand-in (below): nothing here can reach a real one.
vi.mock("../config/database.js", () => ({
  query: mocks.query,
  pool: { connect: mocks.connect },
}));

vi.mock("../services/audit/activityLogger.js", () => ({
  recordActivity: mocks.recordActivity,
}));

const USER = {
  id: "user-1",
  email: "office@renderways.in",
  username: "office",
  role: "SUPER_ADMIN",
  regionId: null,
  region_id: null,
  mustChangePassword: false,
  accessibleSections: null,
};
const SUPER_ADMIN = { currentUser: USER };

// ---------------------------------------------------------------------------------------
// A stand-in for quotations, its line items and the two number series: enough for the
// statements the repository issues, and strict about anything else.
// ---------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

let quotations: Row[];
let counters: Map<string, number>;

/** Whitespace-collapsed SQL, so assertions read the statement rather than its layout. */
function squash(sql: unknown): string {
  return String(sql).replace(/\s+/g, " ").trim();
}

/** Every statement the transaction client issued, in order. */
function statements(): string[] {
  return mocks.clientQuery.mock.calls.map(([sql]) => squash(sql));
}

async function fakeClientQuery(sql: string, params: unknown[] = []) {
  const text = squash(sql);
  if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };

  const sequence = /^INSERT INTO (quotation_sequences|quotation_visit_sequences) \(fin_year, last_seq\) VALUES \(\$1, 1\) ON CONFLICT \(fin_year\) DO UPDATE SET last_seq = (\w+)\.last_seq \+ 1 RETURNING last_seq$/.exec(text);
  if (sequence) {
    // The table bumped must be the table read back, or two series would share a counter.
    expect(sequence[2]).toBe(sequence[1]);
    const key = `${sequence[1]}:${String(params[0])}`;
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
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
      customer_address: p[5],
      customer_city: p[6],
      customer_state: p[7],
      customer_pincode: p[8],
      customer_phone: p[9],
      customer_email: p[10],
      service_description: p[11],
      product_description: p[12],
      model_no: p[13],
      serial_no: p[14],
      base_amount: String(p[15]),
      sgst_percent: String(p[16]),
      cgst_percent: String(p[17]),
      created_by: p[18],
      kind: p[19],
      created_at: "2026-10-29 10:00:00+05:30",
    };
    expect(text).toContain("created_by, kind ) VALUES");
    quotations.push(row);
    return { rows: [row] };
  }

  if (text.startsWith("INSERT INTO quotation_line_items")) return { rows: [] };
  if (text.startsWith("DELETE FROM quotation_line_items")) return { rows: [] };

  if (text.startsWith("UPDATE quotations SET")) {
    const row = quotations.find((q) => q.id === params[0]);
    if (!row) return { rows: [] };
    Object.assign(row, {
      quotation_date: params[1],
      customer_name: params[4],
      updated_by: params[18],
    });
    return { rows: [row] };
  }

  throw new Error(`fake db: unexpected SQL: ${text}`);
}

// ---------------------------------------------------------------------------------------
// Calling a handler the way Express does, errors through the app's own error handler.
// ---------------------------------------------------------------------------------------

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

/** The visit sample 5166159539.pdf, as the Visit form sends it. */
function visitBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: "VISIT",
    quotationDate: "2026-10-24",
    caseId: "5166159539",
    orderNumber: "WO-036344461",
    customerName: "Rajiv Kumar",
    customerEmail: "rajiv@example.com",
    lineItems: [
      {
        serviceDescription: "",
        productDescription: "HP Smart Tank 580 All-in-One Printer",
        modelNo: "TH57MBW1W7",
        serialNo: "1F3Y2A#ACJ",
        baseAmount: 550,
      },
    ],
    sgstPercent: 9,
    cgstPercent: 9,
    ...overrides,
  };
}

/** A Part quotation as today's form sends it: no kind at all. */
function partBody(overrides: Record<string, unknown> = {}) {
  const { kind: _visit, ...rest } = visitBody(overrides);
  return { ...rest, lineItems: [{ serviceDescription: "Service Charge", baseAmount: 950 }] };
}

function insertedKinds(): unknown[] {
  return mocks.clientQuery.mock.calls
    .filter(([sql]) => squash(sql).startsWith("INSERT INTO quotations ("))
    .map(([, params]) => (params as unknown[])[19]);
}

beforeEach(() => {
  vi.clearAllMocks();
  quotations = [];
  counters = new Map();
  mocks.clientQuery.mockImplementation(fakeClientQuery);
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
});

describe("creating a quotation", () => {
  it("is a Part quotation on the QEN series when the body names no kind", async () => {
    const answer = await call(createQuotationController, { ...SUPER_ADMIN, body: partBody() });

    expect(answer.status).toBe(201);
    expect(answer.data.kind).toBe("PART");
    expect(answer.data.quotationNo).toBe("RTPL/26-27/QEN/1");
    expect(statements()).toContain(
      "INSERT INTO quotation_sequences (fin_year, last_seq) VALUES ($1, 1) ON CONFLICT (fin_year) DO UPDATE SET last_seq = quotation_sequences.last_seq + 1 RETURNING last_seq",
    );
    expect(insertedKinds()).toEqual(["PART"]);
  });

  it("numbers a Visit quotation on its own QEV series, apart from the Part one", async () => {
    const numbers: string[] = [];
    for (const body of [partBody(), partBody(), visitBody(), visitBody(), partBody()]) {
      const answer = await call(createQuotationController, { ...SUPER_ADMIN, body });
      expect(answer.status).toBe(201);
      numbers.push(`${answer.data.kind} ${answer.data.quotationNo}`);
    }

    expect(numbers).toEqual([
      "PART RTPL/26-27/QEN/1",
      "PART RTPL/26-27/QEN/2",
      "VISIT RTPL/26-27/QEV/1",
      "VISIT RTPL/26-27/QEV/2",
      "PART RTPL/26-27/QEN/3",
    ]);
    expect(insertedKinds()).toEqual(["PART", "PART", "VISIT", "VISIT", "PART"]);
    expect(
      statements().filter((s) => s.startsWith("INSERT INTO quotation_visit_sequences")),
    ).toHaveLength(2);
  });

  it("starts each financial year's Visit series from 1, by the quotation date", async () => {
    const march = await call(createQuotationController, {
      ...SUPER_ADMIN,
      body: visitBody({ quotationDate: "2027-03-31" }),
    });
    const april = await call(createQuotationController, {
      ...SUPER_ADMIN,
      body: visitBody({ quotationDate: "2027-04-01" }),
    });

    expect(march.data.quotationNo).toBe("RTPL/26-27/QEV/1");
    expect(april.data.quotationNo).toBe("RTPL/27-28/QEV/1");
  });

  it("refuses a kind it does not know, before a number is taken", async () => {
    const answer = await call(createQuotationController, {
      ...SUPER_ADMIN,
      body: visitBody({ kind: "SERVICE" }),
    });

    expect(answer.status).toBe(400);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(quotations).toHaveLength(0);
  });
});

describe("editing a quotation", () => {
  it("keeps the kind it was raised as, whatever the body says", async () => {
    const created = await call(createQuotationController, { ...SUPER_ADMIN, body: visitBody() });
    mocks.clientQuery.mockClear();

    const answer = await call(updateQuotationController, {
      ...SUPER_ADMIN,
      params: { id: created.data.id },
      body: visitBody({ kind: "PART", customerName: "Rajiv Kumar S" }),
    });

    expect(answer.status).toBe(200);
    expect(answer.data.kind).toBe("VISIT");
    expect(answer.data.quotationNo).toBe("RTPL/26-27/QEV/1");
    expect(answer.data.customerName).toBe("Rajiv Kumar S");

    const update = mocks.clientQuery.mock.calls.find(([sql]) =>
      squash(sql).startsWith("UPDATE quotations SET"),
    );
    expect(update).toBeDefined();
    // Neither the statement nor its values can carry a kind.
    expect(squash(update![0]).split(" RETURNING ")[0]).not.toContain("kind");
    expect(update![1] as unknown[]).not.toContain("PART");
    expect(update![1] as unknown[]).not.toContain("VISIT");
    // And no number was taken from either series.
    expect(statements().some((s) => s.includes("_sequences"))).toBe(false);
  });
});

describe("listing quotations", () => {
  const VISIT_ROW = {
    id: "q-9",
    kind: "VISIT",
    quotation_no: "RTPL/26-27/QEV/1",
    quotation_date: "2026-10-24",
    case_id: "",
    order_number: "",
    customer_name: "Rajiv Kumar",
    customer_address: "",
    customer_city: "",
    customer_state: "",
    customer_pincode: "",
    customer_phone: "",
    customer_email: "",
    service_description: "",
    product_description: "HP Smart Tank 580 All-in-One Printer",
    model_no: "TH57MBW1W7",
    serial_no: "1F3Y2A#ACJ",
    base_amount: "550.00",
    sgst_percent: "9.00",
    cgst_percent: "9.00",
    created_by: "office@renderways.in",
    created_at: "2026-10-24 10:00:00+05:30",
  };

  function routeQuery(rows: Row[]) {
    mocks.query.mockImplementation(async (sql: string) => {
      const text = squash(sql);
      if (text.startsWith("SELECT COUNT(*)::TEXT AS count FROM quotations")) {
        return { rows: [{ count: String(rows.length) }] };
      }
      if (text.includes("FROM quotation_line_items")) return { rows: [] };
      if (text.includes("FROM quotations")) return { rows };
      throw new Error(`fake db: unexpected SQL: ${text}`);
    });
  }

  it("asks for one kind when the tab names it, in the count and the rows alike", async () => {
    routeQuery([VISIT_ROW]);

    const answer = await call(listQuotationsController, {
      ...SUPER_ADMIN,
      query: { kind: "visit", search: "rajiv", per_page: "50" },
    });

    expect(answer.status).toBe(200);
    expect(answer.data.items.map((q: { kind: string }) => q.kind)).toEqual(["VISIT"]);
    const [count, rows] = mocks.query.mock.calls.slice(0, 2);
    expect(squash(count![0])).toContain("WHERE (lower(quotation_no) LIKE $1");
    expect(squash(count![0])).toContain("AND kind = $2");
    expect(count![1]).toEqual(["%rajiv%", "VISIT"]);
    expect(squash(rows![0])).toContain("AND kind = $2");
    expect(rows![1]).toEqual(["%rajiv%", "VISIT"]);
  });

  it("lists both kinds when no kind is named, as every older client asks", async () => {
    routeQuery([VISIT_ROW, { ...VISIT_ROW, id: "q-1", kind: null, quotation_no: "RTPL/26-27/QEN/80" }]);

    const answer = await call(listQuotationsController, { ...SUPER_ADMIN, query: {} });

    expect(answer.status).toBe(200);
    expect(squash(mocks.query.mock.calls[0]![0])).not.toContain("kind");
    // A row from before the column existed reads as what it was: a Part quotation.
    expect(answer.data.items.map((q: { kind: string }) => q.kind)).toEqual(["VISIT", "PART"]);
  });

  it("splits by when a quotation was raised, for the page's History", async () => {
    routeQuery([VISIT_ROW]);

    const current = await call(listQuotationsController, {
      ...SUPER_ADMIN,
      query: { kind: "PART", created_from: "2026-10-28T18:30:00.000Z" },
    });
    expect(current.status).toBe(200);
    expect(squash(mocks.query.mock.calls[0]![0])).toContain("AND created_at >= $2::timestamptz");
    expect(mocks.query.mock.calls[0]![1]).toEqual(["PART", "2026-10-28T18:30:00.000Z"]);
    expect(squash(mocks.query.mock.calls[1]![0])).toContain("AND created_at >= $2::timestamptz");

    mocks.query.mockClear();
    const history = await call(listQuotationsController, {
      ...SUPER_ADMIN,
      query: { kind: "PART", created_before: "2026-10-29T00:00:00+05:30" },
    });
    expect(history.status).toBe(200);
    expect(squash(mocks.query.mock.calls[0]![0])).toContain("AND created_at < $2::timestamptz");
    // Read as the same moment, written in one form.
    expect(mocks.query.mock.calls[0]![1]).toEqual(["PART", "2026-10-28T18:30:00.000Z"]);
  });

  it("refuses a moment it cannot read, rather than list everything", async () => {
    routeQuery([]);

    const answer = await call(listQuotationsController, { ...SUPER_ADMIN, query: { created_before: "yesterday" } });

    expect(answer.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("refuses a kind it does not know", async () => {
    routeQuery([]);

    const answer = await call(listQuotationsController, { ...SUPER_ADMIN, query: { kind: "parts" } });

    expect(answer.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
