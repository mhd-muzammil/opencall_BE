import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autofillDeliveryChallan } from "./deliveryChallanAutofillService.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("../../config/database.js", () => ({
  query: mocks.query,
}));

/** Whitespace-collapsed SQL, so the routing below reads the statement, not its layout. */
function squash(sql: unknown): string {
  return String(sql).replace(/\s+/g, " ").trim();
}

/** The newest Flex WIP record for the case, as the quotation auto-fill reads it. */
const FLEX_RECORD = {
  case_id: "5163299011",
  ticket_no: "WO-88123",
  customer_name: "Elancheran M",
  customer_address: "UNIT, DELTA SEZ NOTIFIED AT SY NO.16/1B2B&16/1B2A PLOT NO.1",
  customer_city: "Hosur",
  customer_state: "",
  customer_pincode: "635109",
  customer_phone: "9789 72876",
  customer_email: "elancheran.m@deltaww.com",
  product_name: "HP EliteBook x360 830 G8 Notebook PC (17N15AV)",
  product_number: "402Y3PC",
  product_serial: "5CG303425X",
};

/** The case's Flex rows in its latest batch: one row per part line, as Flex exports them. */
const PART_ROWS = [
  {
    raw_row: {
      "Part Description": "SPS-TOPCOVER W/KB CP BL INDIA",
      "Good Part No": "M45123-001",
      "Part Order No": "PO-1",
    },
  },
  // The same part line again (a re-uploaded export): must not print twice.
  {
    raw_row: {
      "Part Description": "SPS-TOPCOVER W/KB CP BL INDIA",
      "Good Part No": "M45123-001",
      "Part Order No": "PO-1",
    },
  },
  // Column-name variant ("Good Part Number"), read the same way the report generator does.
  {
    raw_row: {
      "Part Description": "SPS-CABLE KIT LCD 13",
      "Good Part Number": "L14378-002",
      "Part Order No": "PO-2",
    },
  },
  // A service call with no spare: nothing to deliver, so no row on the challan.
  { raw_row: { "Customer Name": "Elancheran M" } },
];

/** parts_catalog, answering `part_number = ANY($1)` exactly as Postgres would. */
const CATALOG = [
  { part_number: "M45123-001", hsn_code: "84716040" },
  // Same part in another case: an exact-match lookup must not treat this as L14378-002.
  { part_number: "l14378-002", hsn_code: "85444299" },
];

function fakeDatabase(options: { record?: typeof FLEX_RECORD | null; parts?: unknown[] } = {}) {
  const record = options.record === undefined ? FLEX_RECORD : options.record;
  const parts = options.parts ?? PART_ROWS;
  mocks.query.mockImplementation(async (sql: unknown, params: unknown[] = []) => {
    const text = squash(sql);
    if (text.includes("FROM flex_wip_records fw WHERE ($1 <> ''")) {
      return { rows: record ? [record] : [] };
    }
    if (text.startsWith("WITH latest AS")) {
      return { rows: parts };
    }
    if (text.includes("FROM parts_catalog")) {
      const wanted = params[0] as string[];
      return { rows: CATALOG.filter((row) => wanted.includes(row.part_number)) };
    }
    throw new Error(`unexpected SQL: ${text}`);
  });
}

function callsMatching(fragment: string): unknown[][] {
  return mocks.query.mock.calls.filter(([sql]) => squash(sql).includes(fragment));
}

// The service logs a failed lookup on purpose; keep that out of the test output.
let consoleError: { mockRestore: () => void };

beforeEach(() => {
  mocks.query.mockReset();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("autofillDeliveryChallan", () => {
  it("fills the customer, the product and one goods row per part", async () => {
    fakeDatabase();

    const data = await autofillDeliveryChallan({ caseId: "5163299011" });

    expect(data).toEqual({
      caseId: "5163299011",
      orderNumber: "WO-88123",
      customerName: "Elancheran M",
      customerPhone: "9789 72876",
      customerEmail: "elancheran.m@deltaww.com",
      // Address, city, state, pincode — one per line, the blank state left out.
      customerAddress:
        "UNIT, DELTA SEZ NOTIFIED AT SY NO.16/1B2B&16/1B2A PLOT NO.1\nHosur\n635109",
      productSerial: "5CG303425X",
      productNumber: "402Y3PC",
      productName: "HP EliteBook x360 830 G8 Notebook PC (17N15AV)",
      items: [
        { description: "SPS-TOPCOVER W/KB CP BL INDIA", hsnSac: "84716040", qty: "01", rate: "", per: "" },
        // Only a case-variant of this part number is in the catalog: no exact match, no HSN.
        { description: "SPS-CABLE KIT LCD 13", hsnSac: "", qty: "01", rate: "", per: "" },
      ],
    });
  });

  it("reads the parts from the latest batch, in source order, for the record's case", async () => {
    fakeDatabase();

    await autofillDeliveryChallan({ orderNumber: "WO-88123" });

    // Looked up by WO number, the parts still come from the case the record names.
    const [partsCall] = callsMatching("WITH latest AS");
    expect(partsCall?.[1]).toEqual(["5163299011"]);
    const partsSql = squash(partsCall?.[0]);
    expect(partsSql).toContain("ORDER BY b.created_at DESC LIMIT 1");
    expect(partsSql).toContain("ORDER BY fw.row_number");
  });

  it("asks the catalog for exact part numbers only", async () => {
    fakeDatabase();

    await autofillDeliveryChallan({ caseId: "5163299011" });

    const [catalogCall] = callsMatching("FROM parts_catalog");
    expect(squash(catalogCall?.[0])).toContain("WHERE part_number = ANY($1::text[])");
    expect(squash(catalogCall?.[0])).not.toMatch(/lower\(|ILIKE|LIKE/);
    expect(catalogCall?.[1]).toEqual([["M45123-001", "L14378-002"]]);
  });

  it("answers null for an unknown case and looks nothing else up", async () => {
    fakeDatabase({ record: null });

    expect(await autofillDeliveryChallan({ caseId: "0000000000" })).toBeNull();
    expect(callsMatching("WITH latest AS")).toHaveLength(0);
    expect(callsMatching("FROM parts_catalog")).toHaveLength(0);
  });

  it("skips the catalog when no part carries a number", async () => {
    fakeDatabase({ parts: [{ raw_row: { "Part Description": "SPS-HINGE KIT" } }] });

    const data = await autofillDeliveryChallan({ caseId: "5163299011" });

    expect(data?.items).toEqual([
      { description: "SPS-HINGE KIT", hsnSac: "", qty: "01", rate: "", per: "" },
    ]);
    expect(callsMatching("FROM parts_catalog")).toHaveLength(0);
  });

  it("still fills the customer when the parts lookup fails", async () => {
    fakeDatabase();
    const fake = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      if (squash(sql).startsWith("WITH latest AS")) throw new Error("statement timeout");
      return fake(sql, params);
    });

    const data = await autofillDeliveryChallan({ caseId: "5163299011" });

    expect(data?.customerName).toBe("Elancheran M");
    expect(data?.items).toEqual([]);
  });

  it("leaves the HSN blank when the catalog lookup fails", async () => {
    fakeDatabase();
    const fake = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      if (squash(sql).includes("FROM parts_catalog")) {
        throw Object.assign(new Error('relation "parts_catalog" does not exist'), { code: "42P01" });
      }
      return fake(sql, params);
    });

    const data = await autofillDeliveryChallan({ caseId: "5163299011" });

    expect(data?.items.map((item) => item.hsnSac)).toEqual(["", ""]);
    expect(data?.items.map((item) => item.description)).toEqual([
      "SPS-TOPCOVER W/KB CP BL INDIA",
      "SPS-CABLE KIT LCD 13",
    ]);
  });
});
