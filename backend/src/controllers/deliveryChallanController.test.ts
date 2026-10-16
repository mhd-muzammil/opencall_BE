import type { Request, RequestHandler, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELIVERY_CHALLAN_NOT_SET_UP,
  autofillDeliveryChallanController,
  createDeliveryChallanController,
  getDeliveryChallanController,
  listChallanBranchesController,
  listDeliveryChallansController,
  updateChallanBranchController,
  updateDeliveryChallanController,
} from "./deliveryChallanController.js";
import { errorHandler } from "../middlewares/errorHandler.js";
import { deliveryChallanRouter } from "../routes/deliveryChallanRoutes.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  recordActivity: vi.fn(),
  autofill: vi.fn(),
}));

// The database is a stand-in (below): nothing here can reach a real one.
vi.mock("../config/database.js", () => ({
  query: mocks.query,
  pool: { connect: mocks.connect },
}));

vi.mock("../services/audit/activityLogger.js", () => ({
  recordActivity: mocks.recordActivity,
}));

// The auto-fill mapping has its own tests; here only the controller's handling of it.
vi.mock("../services/deliveryChallans/deliveryChallanAutofillService.js", () => ({
  autofillDeliveryChallan: mocks.autofill,
}));

// The router is imported only to read its route order. Its token guard, and the JWT
// settings behind it, are not what these tests are about.
vi.mock("../middlewares/authMiddleware.js", () => ({
  requirePrincipal: vi.fn(),
}));

// ---------------------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------------------

const USER = {
  id: "user-1",
  email: "owner@renderways.in",
  username: "owner",
  role: "SUPER_ADMIN",
  regionId: null,
  region_id: null,
  mustChangePassword: false,
  accessibleSections: null,
};

const SUPER_ADMIN = { currentUser: USER };
const REGION_ADMIN = {
  currentUser: {
    ...USER,
    id: "user-2",
    email: "hosur.admin@renderways.in",
    role: "REGION_ADMIN",
    regionId: "region-hosur",
    region_id: "region-hosur",
    // Even with the section in their list, a region admin is not let in.
    accessibleSections: ["delivery-challans"],
  },
};
const SPECIAL = {
  id: "sa-1",
  username: "dc-desk",
  roleId: null,
  roleName: null,
  sections: ["delivery-challans"],
  allRegions: true,
  regions: [],
  dataScope: "overall",
  permissionLevel: "edit",
};
const SPECIAL_WITH_GRANT = { specialAccess: SPECIAL };
const SPECIAL_WITHOUT_GRANT = {
  specialAccess: { ...SPECIAL, sections: ["quotations", "parts-catalog"] },
};
const VENDOR = {
  vendorAccess: { id: "va-1", username: "vendor", sections: ["cases"], permissionLevel: "update" },
};
const NOBODY = {};

// ---------------------------------------------------------------------------------------
// A stand-in for the four tables, enough for the statements the repository issues.
// ---------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const HOSUR: Row = {
  branch_key: "hosur",
  name: "Hosur",
  company_line: "Renderways Technologies –",
  address_lines: "L-88A, Rayakottai Hudco, Opp-Murugan Temple\nHosur – 635109",
  gstin: "33AALCR1788A1ZG",
  contact: "+916383428751",
  email: "hosur@renderways.in",
  updated_at: null,
  updated_by: null,
};

const CHENNAI: Row = {
  branch_key: "chennai",
  name: "Chennai",
  company_line: "RENDERWAYS TECHNOLOGY PVT LTD",
  address_lines:
    "# 25, First Floor, Gandhi Street, Mettukuppam\nMaduravoyal, Chennai - 600095\nTamil Nadu",
  gstin: "33AALCR1788A1ZG",
  contact: "9543095480",
  email: "chennai@renderways.in",
  updated_at: null,
  updated_by: null,
};

const db = {
  branches: new Map<string, Row>(),
  sequences: new Map<string, number>(),
  challans: new Map<string, Row>(),
  items: [] as Row[],
  nextId: 1,
};

function resetDb(): void {
  db.branches = new Map([
    ["hosur", { ...HOSUR }],
    ["chennai", { ...CHENNAI }],
  ]);
  db.sequences = new Map();
  db.challans = new Map();
  db.items = [];
  db.nextId = 1;
}

function squash(sql: unknown): string {
  return String(sql).replace(/\s+/g, " ").trim();
}

async function fakeSql(sql: unknown, params: unknown[] = []): Promise<{ rows: unknown[] }> {
  const text = squash(sql);
  const p = (index: number) => params[index];

  if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };

  if (text.includes("FROM challan_branches WHERE branch_key = $1")) {
    const row = db.branches.get(String(p(0)));
    return { rows: row ? [{ ...row }] : [] };
  }
  if (text.endsWith("FROM challan_branches")) {
    return { rows: [...db.branches.values()].map((row) => ({ ...row })) };
  }
  if (text.startsWith("INSERT INTO challan_branches")) {
    const row: Row = {
      branch_key: p(0),
      name: p(1),
      company_line: p(2),
      address_lines: p(3),
      gstin: p(4),
      contact: p(5),
      email: p(6),
      updated_at: "2026-10-16 12:00:00+05:30",
      updated_by: p(7),
    };
    db.branches.set(String(p(0)), row);
    return { rows: [{ ...row }] };
  }
  if (text.startsWith("INSERT INTO challan_sequences")) {
    const key = `${String(p(0))}|${String(p(1))}`;
    const next = (db.sequences.get(key) ?? 0) + 1;
    db.sequences.set(key, next);
    return { rows: [{ last_seq: next }] };
  }
  if (text.startsWith("INSERT INTO delivery_challans")) {
    const row: Row = {
      id: String(db.nextId++),
      branch_key: p(0),
      fin_year: p(1),
      dc_seq: p(2),
      challan_date: p(3),
      // JSONB comes back parsed, as node-postgres returns it.
      branch_header: JSON.parse(String(p(4))),
      customer_name: p(5),
      customer_phone: p(6),
      customer_email: p(7),
      customer_address: p(8),
      case_ids: p(9),
      product_serials: p(10),
      product_numbers: p(11),
      product_names: p(12),
      ref_no_date: p(13),
      mode_terms: p(14),
      other_references: p(15),
      created_by: p(16),
      created_at: "2026-10-16 10:00:00+05:30",
      updated_by: null,
      updated_at: null,
    };
    db.challans.set(String(row.id), row);
    return { rows: [{ ...row }] };
  }
  if (text.startsWith("INSERT INTO delivery_challan_items")) {
    db.items.push({
      challan_id: String(p(0)),
      position: p(1),
      description: p(2),
      hsn_sac: p(3),
      qty: p(4),
      rate: p(5),
      per: p(6),
    });
    return { rows: [] };
  }
  if (text.includes("FROM delivery_challans WHERE id = $1 FOR UPDATE")) {
    const row = db.challans.get(String(p(0)));
    return {
      rows: row ? [{ branch_key: row.branch_key, fin_year: row.fin_year, dc_seq: row.dc_seq }] : [],
    };
  }
  if (text.startsWith("UPDATE delivery_challans")) {
    const row = db.challans.get(String(p(0)));
    if (!row) return { rows: [] };
    Object.assign(row, {
      challan_date: p(1),
      customer_name: p(2),
      customer_phone: p(3),
      customer_email: p(4),
      customer_address: p(5),
      case_ids: p(6),
      product_serials: p(7),
      product_numbers: p(8),
      product_names: p(9),
      ref_no_date: p(10),
      mode_terms: p(11),
      other_references: p(12),
      updated_by: p(13),
      updated_at: "2026-10-16 13:00:00+05:30",
    });
    return { rows: [{ ...row }] };
  }
  if (text.startsWith("DELETE FROM delivery_challan_items")) {
    db.items = db.items.filter((item) => item.challan_id !== String(p(0)));
    return { rows: [] };
  }
  if (text.includes("FROM delivery_challans WHERE id = $1 LIMIT 1")) {
    const row = db.challans.get(String(p(0)));
    return { rows: row ? [{ ...row }] : [] };
  }
  if (text.includes("FROM delivery_challan_items WHERE challan_id = ANY")) {
    const ids = (p(0) as string[]).map(String);
    return {
      rows: db.items
        .filter((item) => ids.includes(String(item.challan_id)))
        .sort((a, b) => Number(a.position) - Number(b.position)),
    };
  }
  if (text.startsWith("SELECT COUNT(*)::TEXT AS count FROM delivery_challans")) {
    return { rows: [{ count: String(db.challans.size) }] };
  }
  if (text.includes("FROM delivery_challans") && text.includes("ORDER BY delivery_challans.id DESC")) {
    return { rows: [...db.challans.values()].reverse().map((row) => ({ ...row })) };
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

function body(overrides: Record<string, unknown> = {}) {
  return {
    branchKey: "hosur",
    challanDate: "2026-10-07",
    customerName: "Elancheran M",
    customerPhone: "9789 72876",
    customerEmail: "elancheran.m@deltaww.com",
    customerAddress:
      "UNIT, DELTA SEZ NOTIFIED AT SY NO.16/1B2B&16/1B2A PLOT NO.1, INDUSTRIAL PARK, KURUBARAPALLI VILLAGE",
    caseIds: "5163299011\n5165190448",
    productSerials: "5CG303425X\n5CD51259LX",
    productNumbers: "402Y3PC\n89T30PC",
    productNames:
      "HP EliteBook x360 830 G8 Notebook PC (17N15AV)\nHP EliteBook 630 13.3 inch G10 Notebook PC (735X3AV)",
    refNoDate: "",
    modeTerms: "",
    otherReferences: "",
    items: [
      { description: "SPS-TOPCOVER W/KB CP BL INDIA", hsnSac: "84716040", qty: "01", rate: "", per: "" },
      { description: "SPS-CABLE KIT LCD 13", hsnSac: "85444299", qty: "01", rate: "", per: "" },
    ],
    ...overrides,
  };
}

const create = (request: object = SUPER_ADMIN, overrides: Record<string, unknown> = {}) =>
  call(createDeliveryChallanController, { ...request, body: body(overrides) });

beforeEach(() => {
  resetDb();
  mocks.query.mockReset().mockImplementation(fakeSql);
  mocks.clientQuery.mockReset().mockImplementation(fakeSql);
  mocks.release.mockReset();
  mocks.connect.mockReset().mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.release,
  });
  mocks.recordActivity.mockReset();
  mocks.autofill.mockReset();
});

// ---------------------------------------------------------------------------------------

describe("access", () => {
  const endpoints: [string, RequestHandler, object][] = [
    ["list", listDeliveryChallansController, {}],
    ["get", getDeliveryChallanController, { params: { id: "1" } }],
    ["create", createDeliveryChallanController, { body: body() }],
    ["update", updateDeliveryChallanController, { params: { id: "1" }, body: body() }],
    ["autofill", autofillDeliveryChallanController, { query: { caseId: "5163299011" } }],
    ["branches", listChallanBranchesController, {}],
  ];
  const refused: [string, object][] = [
    ["a region admin", REGION_ADMIN],
    ["special access without the grant", SPECIAL_WITHOUT_GRANT],
    ["a vendor login", VENDOR],
    ["no principal", NOBODY],
  ];

  for (const [who, principal] of refused) {
    it.each(endpoints)(`refuses ${who} on %s with 403, before touching anything`, async (_name, handler, request) => {
      const answer = await call(handler, { ...principal, ...request });

      expect(answer.status).toBe(403);
      expect(mocks.query).not.toHaveBeenCalled();
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(mocks.autofill).not.toHaveBeenCalled();
      expect(mocks.recordActivity).not.toHaveBeenCalled();
    });
  }

  it("lets a super admin and a granted special-access credential in", async () => {
    expect((await call(listDeliveryChallansController, SUPER_ADMIN)).status).toBe(200);
    expect((await call(listDeliveryChallansController, SPECIAL_WITH_GRANT)).status).toBe(200);

    const raised = await create(SPECIAL_WITH_GRANT);
    expect(raised.status).toBe(201);
    expect(raised.data.createdBy).toBe("special-access:dc-desk");
  });

  describe("branch edit", () => {
    const edit = (principal: object) =>
      call(updateChallanBranchController, {
        ...principal,
        params: { key: "vellore" },
        body: { name: "Vellore", companyLine: "Renderways Technologies –", addressLines: "", gstin: "", contact: "", email: "" },
      });

    it("is SUPER_ADMIN only", async () => {
      expect((await edit(SUPER_ADMIN)).status).toBe(200);
      for (const principal of [REGION_ADMIN, SPECIAL_WITH_GRANT, SPECIAL_WITHOUT_GRANT, VENDOR, NOBODY]) {
        mocks.query.mockClear();
        const answer = await edit(principal);
        expect(answer.status).toBe(403);
        expect(mocks.query).not.toHaveBeenCalled();
      }
    });
  });
});

describe("validation", () => {
  it.each([
    ["no branch", { branchKey: undefined }],
    ["an unknown branch", { branchKey: "mumbai" }],
    ["no date", { challanDate: undefined }],
    ["a date not in YYYY-MM-DD", { challanDate: "07-10-2026" }],
    ["a date that does not exist", { challanDate: "2026-02-30" }],
    ["a date out of range", { challanDate: "0226-10-07" }],
    ["a text field over its limit", { customerName: "x".repeat(301) }],
    ["more than 50 rows", { items: Array.from({ length: 51 }, () => ({ description: "SPS-FAN" })) }],
    ["a row field over its limit", { items: [{ description: "x".repeat(1001) }] }],
    ["a quantity that is not text", { items: [{ description: "SPS-FAN", qty: 1 }] }],
    ["items that are not a list", { items: "SPS-FAN" }],
  ])("refuses %s with 400, without burning a number", async (_name, overrides) => {
    const answer = await create(SUPER_ADMIN, overrides);

    expect(answer.status).toBe(400);
    expect(answer.error?.message).toBe("Invalid delivery challan");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(db.sequences.size).toBe(0);
  });

  it("refuses a missing body with 400", async () => {
    const answer = await call(createDeliveryChallanController, { ...SUPER_ADMIN, body: undefined });
    expect(answer.status).toBe(400);
  });

  it("accepts a challan with no rows, and trims what it is given", async () => {
    const answer = await create(SUPER_ADMIN, {
      items: [],
      customerName: "  Elancheran M  ",
      caseIds: "5163299011\r\n5165190448\n",
    });

    expect(answer.status).toBe(201);
    expect(answer.data.items).toEqual([]);
    expect(answer.data.customerName).toBe("Elancheran M");
    expect(answer.data.caseIds).toBe("5163299011\n5165190448");
  });

  it("refuses an unknown list branch filter with 400", async () => {
    const answer = await call(listDeliveryChallansController, {
      ...SUPER_ADMIN,
      query: { branch: "mumbai" },
    });
    expect(answer.status).toBe(400);
  });

  it("refuses branch details without a name, and an unknown branch", async () => {
    const blank = await call(updateChallanBranchController, {
      ...SUPER_ADMIN,
      params: { key: "salem" },
      body: { name: "  " },
    });
    expect(blank.status).toBe(400);

    const unknown = await call(updateChallanBranchController, {
      ...SUPER_ADMIN,
      params: { key: "mumbai" },
      body: { name: "Mumbai" },
    });
    expect(unknown.status).toBe(404);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that cannot name a challan, without asking the database", async () => {
    const answer = await call(getDeliveryChallanController, { ...SUPER_ADMIN, params: { id: "abc" } });
    expect(answer.status).toBe(404);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("raising and correcting a challan", () => {
  it("raises DC No. 1 for the branch and year, with the branch's letterhead", async () => {
    const answer = await create();

    expect(answer.status).toBe(201);
    expect(answer.data).toMatchObject({
      id: "1",
      branchKey: "hosur",
      finYear: "2026-2027",
      dcSeq: 1,
      challanDate: "2026-10-07",
      branchHeader: {
        branchKey: "hosur",
        name: "Hosur",
        companyLine: "Renderways Technologies –",
        addressLines: "L-88A, Rayakottai Hudco, Opp-Murugan Temple\nHosur – 635109",
        gstin: "33AALCR1788A1ZG",
        contact: "+916383428751",
        email: "hosur@renderways.in",
      },
      createdBy: "owner@renderways.in",
      updatedBy: "",
      updatedAt: null,
    });
    expect(answer.data.items).toHaveLength(2);
    expect(mocks.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: "delivery_challan",
        targetId: "1",
        metadata: expect.objectContaining({ kind: "DELIVERY_CHALLAN_CREATED", dcSeq: 1, finYear: "2026-2027" }),
      }),
    );
  });

  it("numbers per branch and per financial year, March 31 and April 1 included", async () => {
    const raise = async (branchKey: string, challanDate: string) => {
      const { data } = await create(SUPER_ADMIN, { branchKey, challanDate });
      return `${data.branchKey} ${data.dcSeq} ${data.finYear}`;
    };

    expect(await raise("hosur", "2026-03-31")).toBe("hosur 1 2025-2026");
    expect(await raise("hosur", "2026-04-01")).toBe("hosur 1 2026-2027");
    expect(await raise("hosur", "2026-04-01")).toBe("hosur 2 2026-2027");
    expect(await raise("chennai", "2026-04-01")).toBe("chennai 1 2026-2027");
    expect(await raise("hosur", "2026-03-31")).toBe("hosur 2 2025-2026");
  });

  it("refuses to move a challan to another branch", async () => {
    await create();

    const answer = await call(updateDeliveryChallanController, {
      ...SUPER_ADMIN,
      params: { id: "1" },
      body: body({ branchKey: "chennai" }),
    });

    expect(answer.status).toBe(400);
    expect(answer.error?.message).toContain("branch cannot be changed");
    expect(db.challans.get("1")?.branch_key).toBe("hosur");
    expect(mocks.recordActivity).toHaveBeenCalledTimes(1); // the create only
  });

  it("refuses a date in another financial year", async () => {
    await create(SUPER_ADMIN, { challanDate: "2026-04-01" });

    const answer = await call(updateDeliveryChallanController, {
      ...SUPER_ADMIN,
      params: { id: "1" },
      body: body({ challanDate: "2026-03-31" }),
    });

    expect(answer.status).toBe(400);
    expect(answer.error?.message).toContain("2026-2027");
    expect(db.challans.get("1")?.challan_date).toBe("2026-04-01");
  });

  it("corrects the contents and rows under the same number", async () => {
    await create();

    const answer = await call(updateDeliveryChallanController, {
      ...SUPER_ADMIN,
      params: { id: "1" },
      body: body({
        challanDate: "2027-03-31",
        customerName: "Elancheran Murugan",
        items: [{ description: "SPS-CABLE KIT LCD 13", hsnSac: "85444299", qty: "02", rate: "", per: "Nos" }],
      }),
    });

    expect(answer.status).toBe(200);
    expect(answer.data).toMatchObject({
      id: "1",
      dcSeq: 1,
      finYear: "2026-2027",
      challanDate: "2027-03-31",
      customerName: "Elancheran Murugan",
      createdBy: "owner@renderways.in",
      updatedBy: "owner@renderways.in",
    });
    expect(answer.data.items).toEqual([
      { description: "SPS-CABLE KIT LCD 13", hsnSac: "85444299", qty: "02", rate: "", per: "Nos" },
    ]);

    const read = await call(getDeliveryChallanController, { ...SUPER_ADMIN, params: { id: "1" } });
    expect(read.data.items).toEqual(answer.data.items);
    expect(db.sequences.get("hosur|2026-2027")).toBe(1);
    expect(mocks.recordActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        targetType: "delivery_challan",
        metadata: expect.objectContaining({ kind: "DELIVERY_CHALLAN_UPDATED" }),
      }),
    );
  });

  it("answers 404 for a challan that does not exist", async () => {
    const read = await call(getDeliveryChallanController, { ...SUPER_ADMIN, params: { id: "41" } });
    expect(read.status).toBe(404);

    const edit = await call(updateDeliveryChallanController, {
      ...SUPER_ADMIN,
      params: { id: "41" },
      body: body(),
    });
    expect(edit.status).toBe(404);
  });

  it("keeps an issued challan's letterhead when the branch is edited later", async () => {
    const first = await create();

    const edited = await call(updateChallanBranchController, {
      ...SUPER_ADMIN,
      params: { key: "hosur" },
      body: {
        name: "Hosur",
        companyLine: "Renderways Technology Pvt Ltd",
        addressLines: "New premises\r\nHosur – 635110",
        gstin: "33AALCR1788A1ZG",
        contact: "+910000000000",
        email: "hosur.new@renderways.in",
      },
    });
    expect(edited.status).toBe(200);
    expect(edited.data).toMatchObject({
      branchKey: "hosur",
      companyLine: "Renderways Technology Pvt Ltd",
      addressLines: "New premises\nHosur – 635110",
      updatedBy: "owner@renderways.in",
    });
    expect(mocks.recordActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        targetType: "delivery_challan",
        targetId: "hosur",
        metadata: expect.objectContaining({ kind: "DELIVERY_CHALLAN_BRANCH_UPDATED" }),
      }),
    );

    // The challan already issued still prints what it was issued with...
    const reread = await call(getDeliveryChallanController, { ...SUPER_ADMIN, params: { id: "1" } });
    expect(reread.data.branchHeader).toEqual(first.data.branchHeader);
    expect(reread.data.branchHeader.companyLine).toBe("Renderways Technologies –");

    // ...and only challans raised after the edit carry the new text.
    const second = await create();
    expect(second.data.branchHeader.companyLine).toBe("Renderways Technology Pvt Ltd");
    expect(second.data.dcSeq).toBe(2);

    const list = await call(listDeliveryChallansController, SUPER_ADMIN);
    expect(
      list.data.items.map((challan: { dcSeq: number; branchHeader: { companyLine: string } }) => [
        challan.dcSeq,
        challan.branchHeader.companyLine,
      ]),
    ).toEqual([
      [2, "Renderways Technology Pvt Ltd"],
      [1, "Renderways Technologies –"],
    ]);
  });

  it("lists the branches in display order", async () => {
    resetDb();
    db.branches = new Map([
      ["hosur", { ...HOSUR }],
      ["salem", { ...HOSUR, branch_key: "salem", name: "Salem" }],
      ["chennai", { ...CHENNAI }],
    ]);

    const answer = await call(listChallanBranchesController, SPECIAL_WITH_GRANT);

    expect(answer.status).toBe(200);
    expect(answer.data.map((branch: { branchKey: string }) => branch.branchKey)).toEqual([
      "chennai",
      "salem",
      "hosur",
    ]);
  });
});

describe("list filters", () => {
  it("passes search, branch and page size through to the SQL", async () => {
    const answer = await call(listDeliveryChallansController, {
      ...SUPER_ADMIN,
      query: { search: " 67 ", branch: "Hosur", page: "2", pageSize: "10" },
    });

    expect(answer.status).toBe(200);
    const [countSql, countParams] = mocks.query.mock.calls[0] ?? [];
    expect(squash(countSql)).toContain("branch_key = $3");
    expect(countParams).toEqual(["%67%", 67, "hosur"]);
    const [rowsSql] = mocks.query.mock.calls[1] ?? [];
    expect(squash(rowsSql)).toContain("LIMIT 10 OFFSET 10");
    expect(answer.data).toMatchObject({ page: 2, perPage: 10, total: 0, pages: 1, items: [] });
  });
});

describe("before the migration has run", () => {
  const missingTable = () =>
    Object.assign(new Error('relation "delivery_challans" does not exist'), { code: "42P01" });

  beforeEach(() => {
    mocks.query.mockReset().mockRejectedValue(missingTable());
    mocks.clientQuery.mockReset().mockRejectedValue(missingTable());
  });

  it.each([
    ["list", listDeliveryChallansController, {}],
    ["get", getDeliveryChallanController, { params: { id: "1" } }],
    ["create", createDeliveryChallanController, { body: body() }],
    ["update", updateDeliveryChallanController, { params: { id: "1" }, body: body() }],
    ["branches", listChallanBranchesController, {}],
    [
      "branch edit",
      updateChallanBranchController,
      { params: { key: "hosur" }, body: { name: "Hosur" } },
    ],
  ] as [string, RequestHandler, object][])("answers 503 on %s with the command to run", async (_name, handler, request) => {
    const answer = await call(handler, { ...SUPER_ADMIN, ...request });

    expect(answer.status).toBe(503);
    expect(answer.error?.message).toBe(DELIVERY_CHALLAN_NOT_SET_UP);
    expect(answer.error?.message).toContain("npm run migrate:delivery-challans");
  });

  it("hands the connection back after a refused transaction", async () => {
    await create();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("does not dress up any other database error as 'not set up'", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.query.mockReset().mockRejectedValue(Object.assign(new Error("deadlock"), { code: "40P01" }));

    const answer = await call(listDeliveryChallansController, SUPER_ADMIN);

    expect(answer.status).toBe(500);
    consoleError.mockRestore();
  });
});

describe("autofill", () => {
  it("asks for a case id or order number", async () => {
    const answer = await call(autofillDeliveryChallanController, SUPER_ADMIN);
    expect(answer.status).toBe(400);
    expect(mocks.autofill).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown case", async () => {
    mocks.autofill.mockResolvedValue(null);

    const answer = await call(autofillDeliveryChallanController, {
      ...SUPER_ADMIN,
      query: { caseId: " 0000000000 " },
    });

    expect(answer.status).toBe(404);
    expect(answer.error?.message).toContain("No matching case found");
    expect(mocks.autofill).toHaveBeenCalledWith({ caseId: "0000000000", orderNumber: "" });
  });

  it("returns the prefill in the { data } envelope", async () => {
    const prefill = {
      caseId: "5163299011",
      orderNumber: "WO-88123",
      customerName: "Elancheran M",
      customerPhone: "9789 72876",
      customerEmail: "elancheran.m@deltaww.com",
      customerAddress: "UNIT, DELTA SEZ\nHosur\n635109",
      productSerial: "5CG303425X",
      productNumber: "402Y3PC",
      productName: "HP EliteBook x360 830 G8 Notebook PC (17N15AV)",
      items: [{ description: "SPS-CABLE KIT LCD 13", hsnSac: "85444299", qty: "01", rate: "", per: "" }],
    };
    mocks.autofill.mockResolvedValue(prefill);

    const answer = await call(autofillDeliveryChallanController, {
      ...SPECIAL_WITH_GRANT,
      query: { orderNumber: "WO-88123" },
    });

    expect(answer.status).toBe(200);
    expect(answer.data).toEqual(prefill);
  });
});

describe("routes", () => {
  it("declares /autofill and /branches before /:id", () => {
    const stack = (deliveryChallanRouter as unknown as {
      stack: { route?: { path: string; methods: Record<string, boolean> } }[];
    }).stack;
    const routes = stack
      .filter((layer) => layer.route)
      .map((layer) => `${Object.keys(layer.route!.methods)[0]?.toUpperCase()} ${layer.route!.path}`);

    expect(routes).toEqual([
      "GET /autofill",
      "GET /branches",
      "PUT /branches/:key",
      "GET /",
      "GET /:id",
      "POST /",
      "PUT /:id",
    ]);
  });
});
