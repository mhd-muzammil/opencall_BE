import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  challanFinancialYear,
  createDeliveryChallan,
  dcNumberFromSearch,
  findDeliveryChallanById,
  isDeliveryChallanSchemaMissing,
  listChallanBranches,
  listDeliveryChallans,
  saveChallanBranch,
  updateDeliveryChallan,
  type CreateDeliveryChallanInput,
} from "./deliveryChallanRepository.js";

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../config/database.js", () => ({
  query: mocks.query,
  pool: { connect: mocks.connect },
}));

const HOSUR_ROW = {
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

const CHENNAI_ROW = {
  ...HOSUR_ROW,
  branch_key: "chennai",
  name: "Chennai",
  company_line: "RENDERWAYS TECHNOLOGY PVT LTD",
  address_lines:
    "# 25, First Floor, Gandhi Street, Mettukuppam\nMaduravoyal, Chennai - 600095\nTamil Nadu",
  contact: "9543095480",
  email: "chennai@renderways.in",
};

/** Whitespace-collapsed SQL, so assertions read the statement rather than its layout. */
function squash(sql: unknown): string {
  return String(sql).replace(/\s+/g, " ").trim();
}

/** Every statement the transaction client issued, in order. */
function statements(): string[] {
  return mocks.clientQuery.mock.calls.map(([sql]) => squash(sql));
}

/**
 * A stand-in for Postgres that answers the statements createDeliveryChallan issues. The
 * sequence statement is given its real semantics — one counter per (branch, fin_year),
 * first use 1, every later use +1 — so the numbering tests exercise what the code passes
 * to it and what it does with the answer.
 */
function fakeChallanDatabase(branches = [HOSUR_ROW, CHENNAI_ROW]) {
  const sequences = new Map<string, number>();
  let nextId = 1;
  mocks.clientQuery.mockImplementation(async (sql: unknown, params: unknown[] = []) => {
    const text = squash(sql);
    if (text.includes("FROM challan_branches WHERE branch_key = $1")) {
      return { rows: branches.filter((row) => row.branch_key === params[0]) };
    }
    if (text.startsWith("INSERT INTO challan_sequences")) {
      const key = `${String(params[0])}|${String(params[1])}`;
      const next = (sequences.get(key) ?? 0) + 1;
      sequences.set(key, next);
      return { rows: [{ last_seq: next }] };
    }
    if (text.startsWith("INSERT INTO delivery_challans")) {
      return {
        rows: [
          {
            id: String(nextId++),
            branch_key: params[0],
            fin_year: params[1],
            dc_seq: params[2],
            challan_date: params[3],
            branch_header: JSON.parse(String(params[4])),
            customer_name: params[5],
            customer_phone: params[6],
            customer_email: params[7],
            customer_address: params[8],
            case_ids: params[9],
            product_serials: params[10],
            product_numbers: params[11],
            product_names: params[12],
            ref_no_date: params[13],
            mode_terms: params[14],
            other_references: params[15],
            created_by: params[16],
            created_at: "2026-10-16 10:00:00+05:30",
            updated_by: null,
            updated_at: null,
          },
        ],
      };
    }
    return { rows: [], rowCount: 0 };
  });
}

function input(overrides: Partial<CreateDeliveryChallanInput> = {}): CreateDeliveryChallanInput {
  return {
    branchKey: "hosur",
    challanDate: "2026-10-07",
    customerName: "Elancheran M",
    customerPhone: "9789 72876",
    customerEmail: "elancheran.m@deltaww.com",
    customerAddress: "UNIT, DELTA SEZ NOTIFIED AT SY NO.16/1B2B&16/1B2A",
    caseIds: "5163299011\n5165190448",
    productSerials: "5CG303425X\n5CD51259LX",
    productNumbers: "402Y3PC\n89T30PC",
    productNames: "HP EliteBook x360 830 G8 Notebook PC (17N15AV)",
    refNoDate: "",
    modeTerms: "",
    otherReferences: "",
    items: [
      { description: "SPS-TOPCOVER W/KB CP BL INDIA", hsnSac: "84716040", qty: "01", rate: "", per: "" },
      { description: "SPS-CABLE KIT LCD 13", hsnSac: "85444299", qty: "01", rate: "", per: "" },
    ],
    createdBy: "owner@renderways.in",
    ...overrides,
  };
}

function challanRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "7",
    branch_key: "hosur",
    fin_year: "2026-2027",
    dc_seq: 67,
    challan_date: "2026-10-07",
    branch_header: {
      branchKey: "hosur",
      name: "Hosur",
      companyLine: "Renderways Technologies –",
      addressLines: "L-88A, Rayakottai Hudco, Opp-Murugan Temple\nHosur – 635109",
      gstin: "33AALCR1788A1ZG",
      contact: "+916383428751",
      email: "hosur@renderways.in",
    },
    customer_name: "Elancheran M",
    customer_phone: "9789 72876",
    customer_email: "elancheran.m@deltaww.com",
    customer_address: "UNIT, DELTA SEZ",
    case_ids: "5163299011\n5165190448",
    product_serials: "5CG303425X\n5CD51259LX",
    product_numbers: "402Y3PC\n89T30PC",
    product_names: "HP EliteBook x360 830 G8 Notebook PC (17N15AV)",
    ref_no_date: "",
    mode_terms: "",
    other_references: "",
    created_by: "owner@renderways.in",
    created_at: "2026-10-07 11:00:00+05:30",
    updated_by: null,
    updated_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.clientQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mocks.release.mockReset();
  mocks.connect.mockReset().mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.release,
  });
  mocks.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("challanFinancialYear", () => {
  it("turns on April 1, not January 1", () => {
    expect(challanFinancialYear("2026-03-31")).toBe("2025-2026");
    expect(challanFinancialYear("2026-04-01")).toBe("2026-2027");
    expect(challanFinancialYear("2027-01-15")).toBe("2026-2027");
    expect(challanFinancialYear("2026-12-31")).toBe("2026-2027");
  });

  it("prints the year as the sheet does — four digits both sides", () => {
    expect(challanFinancialYear("2026-10-07")).toBe("2026-2027");
    expect(challanFinancialYear("2099-04-01")).toBe("2099-2100");
  });
});

describe("createDeliveryChallan numbering", () => {
  it("numbers each branch and financial year from 1, and restarts every April 1", async () => {
    fakeChallanDatabase();

    const raise = async (branchKey: "hosur" | "chennai", challanDate: string) => {
      const challan = await createDeliveryChallan(input({ branchKey, challanDate }));
      return `${challan?.branchKey} ${challan?.dcSeq} ${challan?.finYear}`;
    };

    expect(await raise("hosur", "2026-03-30")).toBe("hosur 1 2025-2026");
    // March 31 is still the old year: the same series carries on.
    expect(await raise("hosur", "2026-03-31")).toBe("hosur 2 2025-2026");
    // April 1 opens a new year, and with it a new series from 1.
    expect(await raise("hosur", "2026-04-01")).toBe("hosur 1 2026-2027");
    // Another branch on the same day keeps its own series.
    expect(await raise("chennai", "2026-04-01")).toBe("chennai 1 2026-2027");
    expect(await raise("hosur", "2026-04-02")).toBe("hosur 2 2026-2027");
    // A late entry dated in the old year continues the old year's series.
    expect(await raise("hosur", "2026-02-10")).toBe("hosur 3 2025-2026");
  });

  it("allocates with ONE locking upsert inside the challan's own transaction", async () => {
    fakeChallanDatabase();

    await createDeliveryChallan(input({ challanDate: "2026-04-01" }));

    const sqls = statements();
    const sequenceStatements = sqls.filter((sql) => sql.includes("challan_sequences"));
    // One statement both allocates and reads the number back: no SELECT-then-UPDATE gap
    // for a second save to slip through.
    expect(sequenceStatements).toEqual([
      "INSERT INTO challan_sequences (branch_key, fin_year, last_seq) VALUES ($1, $2, 1) " +
        "ON CONFLICT (branch_key, fin_year) DO UPDATE SET last_seq = challan_sequences.last_seq + 1 " +
        "RETURNING last_seq",
    ]);
    expect(sqls.some((sql) => /max\s*\(\s*dc_seq/i.test(sql))).toBe(false);

    // ...keyed on (branch, financial year of the challan date)...
    const sequenceCall = mocks.clientQuery.mock.calls.find(([sql]) =>
      squash(sql).startsWith("INSERT INTO challan_sequences"),
    );
    expect(sequenceCall?.[1]).toEqual(["hosur", "2026-2027"]);

    // ...and all on one connection between BEGIN and COMMIT, so the row lock the upsert
    // takes is held until the challan itself is written.
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
    const at = (prefix: string) => sqls.findIndex((sql) => sql.startsWith(prefix));
    expect(at("INSERT INTO challan_sequences")).toBeGreaterThan(at("BEGIN"));
    expect(at("INSERT INTO delivery_challans")).toBeGreaterThan(at("INSERT INTO challan_sequences"));
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("writes the allocated number, the FY and the items in entry order", async () => {
    fakeChallanDatabase();

    const challan = await createDeliveryChallan(input());

    const insert = mocks.clientQuery.mock.calls.find(([sql]) =>
      squash(sql).startsWith("INSERT INTO delivery_challans"),
    ) as [string, unknown[]];
    expect(insert[1].slice(0, 4)).toEqual(["hosur", "2026-2027", 1, "2026-10-07"]);

    const itemCalls = mocks.clientQuery.mock.calls.filter(([sql]) =>
      squash(sql).startsWith("INSERT INTO delivery_challan_items"),
    ) as [string, unknown[]][];
    expect(itemCalls.map(([, params]) => params)).toEqual([
      [challan?.id, 0, "SPS-TOPCOVER W/KB CP BL INDIA", "84716040", "01", "", ""],
      [challan?.id, 1, "SPS-CABLE KIT LCD 13", "85444299", "01", "", ""],
    ]);
    expect(challan?.items).toEqual(input().items);
  });

  it("copies the branch letterhead onto the challan as it stands at creation", async () => {
    fakeChallanDatabase();

    const challan = await createDeliveryChallan(input());

    const insert = mocks.clientQuery.mock.calls.find(([sql]) =>
      squash(sql).startsWith("INSERT INTO delivery_challans"),
    ) as [string, unknown[]];
    expect(squash(insert[0])).toContain("$5::jsonb");
    const header = {
      branchKey: "hosur",
      name: "Hosur",
      companyLine: "Renderways Technologies –",
      addressLines: "L-88A, Rayakottai Hudco, Opp-Murugan Temple\nHosur – 635109",
      gstin: "33AALCR1788A1ZG",
      contact: "+916383428751",
      email: "hosur@renderways.in",
    };
    expect(JSON.parse(String(insert[1][4]))).toEqual(header);
    expect(challan?.branchHeader).toEqual(header);
  });

  it("allocates nothing when the branch row is missing", async () => {
    fakeChallanDatabase([CHENNAI_ROW]);

    const challan = await createDeliveryChallan(input({ branchKey: "hosur" }));

    expect(challan).toBeNull();
    expect(statements()).toEqual([
      "BEGIN",
      expect.stringContaining("FROM challan_branches WHERE branch_key = $1"),
      "ROLLBACK",
    ]);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("rolls the number back when the save fails part-way", async () => {
    fakeChallanDatabase();
    const fake = mocks.clientQuery.getMockImplementation()!;
    mocks.clientQuery.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      if (squash(sql).startsWith("INSERT INTO delivery_challan_items")) {
        throw new Error("disk full");
      }
      return fake(sql, params);
    });

    await expect(createDeliveryChallan(input())).rejects.toThrow("disk full");
    expect(statements()).toContain("ROLLBACK");
    expect(statements()).not.toContain("COMMIT");
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});

describe("updateDeliveryChallan", () => {
  function current(row: { branch_key: string; fin_year: string; dc_seq: number }) {
    mocks.clientQuery.mockImplementation(async (sql: unknown) => {
      const text = squash(sql);
      if (text.includes("FOR UPDATE")) return { rows: [row] };
      if (text.startsWith("UPDATE delivery_challans")) {
        return { rows: [challanRow({ ...row, challan_date: "2026-03-31" })] };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  const edit = (overrides: Partial<CreateDeliveryChallanInput> = {}) => {
    const { createdBy: _createdBy, ...rest } = input(overrides);
    return { ...rest, updatedBy: "editor@renderways.in" };
  };

  it("refuses a branch change and leaves the challan untouched", async () => {
    current({ branch_key: "hosur", fin_year: "2026-2027", dc_seq: 67 });

    const result = await updateDeliveryChallan("7", edit({ branchKey: "chennai" }));

    expect(result).toEqual({
      status: "branch_locked",
      branchKey: "hosur",
      finYear: "2026-2027",
      dcSeq: 67,
    });
    expect(statements().some((sql) => sql.startsWith("UPDATE"))).toBe(false);
    expect(statements()).toContain("ROLLBACK");
  });

  it("refuses a date moved across April 1 into another financial year", async () => {
    current({ branch_key: "hosur", fin_year: "2025-2026", dc_seq: 12 });

    const result = await updateDeliveryChallan("7", edit({ challanDate: "2026-04-01" }));

    expect(result).toEqual({
      status: "fin_year_locked",
      branchKey: "hosur",
      finYear: "2025-2026",
      dcSeq: 12,
    });
    expect(statements().some((sql) => sql.startsWith("UPDATE"))).toBe(false);
  });

  it("accepts a new date inside the same financial year", async () => {
    current({ branch_key: "hosur", fin_year: "2025-2026", dc_seq: 12 });

    const result = await updateDeliveryChallan("7", edit({ challanDate: "2026-03-31" }));

    expect(result.status).toBe("updated");
  });

  it("answers not_found for an unknown id", async () => {
    current({ branch_key: "hosur", fin_year: "2026-2027", dc_seq: 67 });
    mocks.clientQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));

    const result = await updateDeliveryChallan("999", edit());

    expect(result).toEqual({ status: "not_found" });
  });

  it("rewrites the contents and items, never the number, branch, year or letterhead", async () => {
    current({ branch_key: "hosur", fin_year: "2026-2027", dc_seq: 67 });

    const result = await updateDeliveryChallan("7", edit());

    expect(result.status).toBe("updated");
    const sqls = statements();
    const update = sqls.find((sql) => sql.startsWith("UPDATE delivery_challans")) ?? "";
    const setClause = update.slice(0, update.indexOf("WHERE"));
    for (const fixed of ["branch_key =", "fin_year =", "dc_seq =", "branch_header =", "created_by =", "created_at ="]) {
      expect(setClause).not.toContain(fixed);
    }
    expect(setClause).toContain("updated_at = NOW()");
    expect(sqls.some((sql) => sql.includes("challan_sequences"))).toBe(false);

    // Items replaced wholesale, in entry order, after the old ones are cleared.
    const deleteAt = sqls.findIndex((sql) =>
      sql.startsWith("DELETE FROM delivery_challan_items WHERE challan_id = $1"),
    );
    const firstInsertAt = sqls.findIndex((sql) => sql.startsWith("INSERT INTO delivery_challan_items"));
    expect(deleteAt).toBeGreaterThan(-1);
    expect(firstInsertAt).toBeGreaterThan(deleteAt);
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
  });
});

describe("listDeliveryChallans", () => {
  function sqlAndParams(index: number): [string, unknown[]] {
    const [sql, params] = mocks.query.mock.calls[index] ?? [];
    return [squash(sql), params as unknown[]];
  }

  it("reads newest first, paged, with no filter when none is given", async () => {
    await listDeliveryChallans({ page: 1, perPage: 30 });

    const [countSql, countParams] = sqlAndParams(0);
    const [rowsSql] = sqlAndParams(1);
    expect(countSql).toBe("SELECT COUNT(*)::TEXT AS count FROM delivery_challans");
    expect(countParams).toEqual([]);
    // By id, which is drawn after the number: two saves for one branch at once list in
    // number order, which created_at (the transaction's start) does not promise. The
    // table's id, not the `id::TEXT` output column, which would put "9" after "18".
    expect(rowsSql).toContain("ORDER BY delivery_challans.id DESC");
    expect(rowsSql).not.toContain("created_at DESC");
    expect(rowsSql).toContain("LIMIT 30 OFFSET 0");
  });

  it("passes the search and the branch filter to the SQL as parameters", async () => {
    await listDeliveryChallans({ search: "67", branchKey: "hosur", page: 1, perPage: 30 });

    const [countSql, countParams] = sqlAndParams(0);
    const [rowsSql, rowsParams] = sqlAndParams(1);
    expect(countSql).toContain(
      "WHERE (dc_seq = $2 OR lower(customer_name) LIKE $1 OR lower(case_ids) LIKE $1) AND branch_key = $3",
    );
    expect(countParams).toEqual(["%67%", 67, "hosur"]);
    expect(rowsParams).toEqual(countParams);
    expect(rowsSql).toContain("branch_key = $3");
  });

  it("matches text searches on customer name and case ids only", async () => {
    await listDeliveryChallans({ search: "Elancheran", page: 1, perPage: 30 });

    const [countSql, countParams] = sqlAndParams(0);
    expect(countSql).toContain("WHERE (lower(customer_name) LIKE $1 OR lower(case_ids) LIKE $1)");
    expect(countSql).not.toContain("dc_seq");
    expect(countParams).toEqual(["%elancheran%"]);
  });

  it("filters by branch alone", async () => {
    await listDeliveryChallans({ branchKey: "salem", page: 1, perPage: 30 });

    const [countSql, countParams] = sqlAndParams(0);
    expect(countSql).toContain("WHERE branch_key = $1");
    expect(countParams).toEqual(["salem"]);
  });

  it("pages and caps the page size", async () => {
    await listDeliveryChallans({ page: 3, perPage: 10 });
    expect(sqlAndParams(1)[0]).toContain("LIMIT 10 OFFSET 20");

    mocks.query.mockClear();
    await listDeliveryChallans({ page: 1, perPage: 5000 });
    expect(sqlAndParams(1)[0]).toContain("LIMIT 100 OFFSET 0");
  });

  it("returns full challans, items attached in one query", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ count: "2" }] })
      .mockResolvedValueOnce({ rows: [challanRow({ id: "9", dc_seq: 68 }), challanRow()] })
      .mockResolvedValueOnce({
        rows: [
          { challan_id: "7", description: "SPS-CABLE KIT LCD 13", hsn_sac: "85444299", qty: "01", rate: "", per: "" },
          { challan_id: "9", description: "SPS-BATTERY", hsn_sac: "", qty: "01", rate: "", per: "" },
        ],
      });

    const result = await listDeliveryChallans({ page: 1, perPage: 30 });

    const [itemsSql, itemsParams] = sqlAndParams(2);
    expect(itemsSql).toContain("WHERE challan_id = ANY($1::bigint[])");
    expect(itemsParams).toEqual([["9", "7"]]);
    expect(result.total).toBe(2);
    expect(result.pages).toBe(1);
    expect(result.items.map((challan) => [challan.id, challan.dcSeq, challan.items.length])).toEqual([
      ["9", 68, 1],
      ["7", 67, 1],
    ]);
    expect(result.items[1]?.items[0]).toEqual({
      description: "SPS-CABLE KIT LCD 13",
      hsnSac: "85444299",
      qty: "01",
      rate: "",
      per: "",
    });
  });
});

describe("dcNumberFromSearch", () => {
  it("reads a DC number however it is typed, and nothing else", () => {
    expect(dcNumberFromSearch("67")).toBe(67);
    expect(dcNumberFromSearch("DC 67")).toBe(67);
    expect(dcNumberFromSearch("dc no. 67")).toBe(67);
    expect(dcNumberFromSearch("Elancheran")).toBeNull();
    // A 10-digit case id is a case id, not a DC number.
    expect(dcNumberFromSearch("5163299011")).toBeNull();
  });
});

describe("findDeliveryChallanById", () => {
  it("prints the challan's OWN letterhead copy, never the branch's current one", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [challanRow()] })
      .mockResolvedValueOnce({ rows: [] });

    const challan = await findDeliveryChallanById("7");

    const [selectSql] = mocks.query.mock.calls[0] ?? [];
    expect(squash(selectSql)).not.toContain("challan_branches");
    expect(challan?.branchHeader.companyLine).toBe("Renderways Technologies –");
    expect(challan?.items).toEqual([]);
  });

  it("answers null for an unknown id", async () => {
    expect(await findDeliveryChallanById("404")).toBeNull();
  });
});

describe("branches", () => {
  it("lists the five in display order whatever order the table returns", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: ["hosur", "salem", "chennai", "kanchipuram", "vellore"].map((key) => ({
        ...HOSUR_ROW,
        branch_key: key,
      })),
    });

    const branches = await listChallanBranches();

    expect(branches.map((branch) => branch.branchKey)).toEqual([
      "chennai",
      "vellore",
      "salem",
      "kanchipuram",
      "hosur",
    ]);
    expect(branches[0]?.updatedBy).toBe("");
    expect(branches[0]?.updatedAt).toBeNull();
  });

  it("saves a branch without touching any challan", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ ...HOSUR_ROW, company_line: "Renderways Technologies Pvt Ltd", updated_at: "2026-10-16 12:00:00+05:30", updated_by: "owner@renderways.in" }],
    });

    const saved = await saveChallanBranch(
      "hosur",
      {
        name: "Hosur",
        companyLine: "Renderways Technologies Pvt Ltd",
        addressLines: HOSUR_ROW.address_lines,
        gstin: HOSUR_ROW.gstin,
        contact: HOSUR_ROW.contact,
        email: HOSUR_ROW.email,
      },
      "owner@renderways.in",
    );

    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.query.mock.calls[0] ?? [];
    expect(squash(sql)).toContain("INSERT INTO challan_branches");
    expect(squash(sql)).toContain("ON CONFLICT (branch_key) DO UPDATE SET");
    expect(squash(sql)).not.toContain("delivery_challans");
    expect(params).toEqual([
      "hosur",
      "Hosur",
      "Renderways Technologies Pvt Ltd",
      HOSUR_ROW.address_lines,
      HOSUR_ROW.gstin,
      HOSUR_ROW.contact,
      HOSUR_ROW.email,
      "owner@renderways.in",
    ]);
    expect(saved.companyLine).toBe("Renderways Technologies Pvt Ltd");
    expect(saved.updatedBy).toBe("owner@renderways.in");
  });
});

describe("isDeliveryChallanSchemaMissing", () => {
  it("recognises Postgres undefined_table and nothing else", () => {
    expect(isDeliveryChallanSchemaMissing({ code: "42P01" })).toBe(true);
    expect(isDeliveryChallanSchemaMissing({ code: "23505" })).toBe(false);
    expect(isDeliveryChallanSchemaMissing(new Error("boom"))).toBe(false);
    expect(isDeliveryChallanSchemaMissing(null)).toBe(false);
  });
});
