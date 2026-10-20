import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listCaseClosureDatesForAsp,
  summarizeCaseClosureDatesByAsp,
} from "./caseClosureDateRepository.js";

/**
 * The Closed Calls summary and its drill-down list, as the repository sees them.
 *
 * `query` is mocked: these tests pin what the TypeScript does with the rows Postgres
 * returns and what SQL / parameters it sends. They do NOT execute the SQL, so they cannot
 * prove the database returns the same rows — that needs a restored non-production database.
 */

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("../config/database.js", () => ({
  query: mocks.query,
  pool: { connect: mocks.connect },
}));

type Row = Record<string, unknown>;

/** Answer the flex_raw_records existence probe, then return `rows` for the real query. */
function respond(rows: Row[], opts: { rawTable?: boolean } = {}) {
  const rawTable = opts.rawTable ?? true;
  mocks.query.mockImplementation(async (sql: string) => {
    if (String(sql).includes("to_regclass")) {
      return { rows: [{ reg: rawTable ? "flex_raw_records" : null }] };
    }
    return { rows };
  });
}

/** The data query (not the existence probe): SQL whitespace-collapsed, plus its params. */
function dataCall(): { sql: string; params: unknown[] } {
  const call = mocks.query.mock.calls.find(([sql]) => !String(sql).includes("to_regclass"));
  if (!call) throw new Error("no data query issued");
  return { sql: String(call[0]).replace(/\s+/g, " ").trim(), params: call[1] as unknown[] };
}

beforeEach(() => {
  mocks.query.mockReset();
});

function summaryRow(
  aspCode: string,
  month: string,
  count: number,
  closed: number,
  cancelled: number,
  other: number,
): Row {
  // Postgres returns COUNT(*)::TEXT, so the counts arrive as strings.
  return {
    asp_code: aspCode,
    month,
    count: String(count),
    closed: String(closed),
    cancelled: String(cancelled),
    other: String(other),
  };
}

describe("summarizeCaseClosureDatesByAsp — output and region roll-up", () => {
  it("rolls months up per region, sums the outcome split, and keeps unmatched off the cards", async () => {
    respond([
      summaryRow("ASPS01461", "2026-08", 3, 2, 1, 0),
      summaryRow("ASPS01461", "2026-09", 3, 3, 0, 0),
      summaryRow("ASPS01511", "2026-09", 5, 4, 0, 1),
      summaryRow("", "2026-09", 2, 2, 0, 0),
    ]);

    const summary = await summarizeCaseClosureDatesByAsp({ dateFrom: "2026-08-01", dateTo: "2026-09-30" });

    expect(summary.total).toBe(13);
    expect(summary.closed).toBe(11);
    expect(summary.cancelled).toBe(1);
    expect(summary.other).toBe(1);
    expect(summary.unmatched).toBe(2);
    // Biggest region first; the unmatched '' bucket never becomes a region card.
    expect(summary.byAsp).toEqual([
      { aspCode: "ASPS01461", count: 6, closed: 5, cancelled: 1, other: 0 },
      { aspCode: "ASPS01511", count: 5, closed: 4, cancelled: 0, other: 1 },
    ]);
    // ...but it stays in the per-month rows so the "All Regions" month total is complete.
    expect(summary.byAspMonth).toHaveLength(4);
    expect(summary.byAspMonth.find((m) => m.aspCode === "")).toMatchObject({ month: "2026-09", count: 2 });
    expect(summary.months).toEqual(["2026-08", "2026-09"]);
  });

  it("returns an all-zero summary when there are no closures", async () => {
    respond([]);
    const summary = await summarizeCaseClosureDatesByAsp();
    expect(summary).toEqual({
      total: 0,
      closed: 0,
      cancelled: 0,
      other: 0,
      unmatched: 0,
      byAsp: [],
      byAspMonth: [],
      months: [],
    });
  });

  it("passes the date bounds as parameters, '' meaning unbounded", async () => {
    respond([]);
    await summarizeCaseClosureDatesByAsp({ dateFrom: "2026-09-01", dateTo: "2026-09-30" });
    expect(dataCall().params).toEqual(["2026-09-01", "2026-09-30"]);

    mocks.query.mockClear();
    await summarizeCaseClosureDatesByAsp();
    expect(dataCall().params).toEqual(["", ""]);
  });

  it("filters on closed_on (not closure_date) and prefers the file's own work location", async () => {
    respond([]);
    await summarizeCaseClosureDatesByAsp({ dateFrom: "2026-09-01", dateTo: "2026-09-30" });
    const { sql } = dataCall();
    expect(sql).toContain("closure.closed_on >= $1::date");
    expect(sql).toContain("closure.closed_on <= $2::date");
    expect(sql).not.toMatch(/closure_date\s*>=/);
    expect(sql).toContain("COALESCE(NULLIF(closure.work_location, ''), by_wo.loc, by_case.loc, '')");
  });

  it("traces through the raw Flex export only when that table exists", async () => {
    respond([], { rawTable: true });
    await summarizeCaseClosureDatesByAsp();
    expect(dataCall().sql).toContain("flex_raw_records");

    mocks.query.mockReset();
    respond([], { rawTable: false });
    await summarizeCaseClosureDatesByAsp();
    expect(dataCall().sql).not.toContain("flex_raw_records");
  });
});

describe("listCaseClosureDatesForAsp — drill-down list", () => {
  it("maps rows and reads the true total from the window count", async () => {
    respond([
      {
        wo_id: "WO-2",
        case_id: "C-2",
        closure_date: "30-09-2026",
        closure_status: "WO Closed",
        asp_code: "ASPS01511",
        total_count: "2500",
      },
      {
        wo_id: "WO-1",
        case_id: "C-1",
        closure_date: null,
        closure_status: null,
        asp_code: "",
        total_count: "2500",
      },
    ]);

    const list = await listCaseClosureDatesForAsp({ aspCode: "", dateFrom: "", dateTo: "" });

    expect(list.total).toBe(2500);
    expect(list.rows).toEqual([
      { woId: "WO-2", caseId: "C-2", closureDate: "30-09-2026", aspCode: "ASPS01511", closureStatus: "WO Closed" },
      // A cancellation with no closure date / status comes back as '' — never null.
      { woId: "WO-1", caseId: "C-1", closureDate: "", aspCode: "", closureStatus: "" },
    ]);
  });

  it("returns total 0 for an empty result", async () => {
    respond([]);
    expect(await listCaseClosureDatesForAsp({ aspCode: "ASPS01511", dateFrom: "", dateTo: "" })).toEqual({
      rows: [],
      total: 0,
    });
  });

  it("sends asp / dates / allowed scope / status group in that order, with safe defaults", async () => {
    respond([]);
    await listCaseClosureDatesForAsp({
      aspCode: "ASPS01511",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      statusGroup: "cancelled",
      allowedAspCodes: ["ASPS01511"],
    });
    expect(dataCall().params).toEqual(["ASPS01511", "2026-09-01", "2026-09-30", ["ASPS01511"], "cancelled"]);

    mocks.query.mockClear();
    await listCaseClosureDatesForAsp({ aspCode: "", dateFrom: "", dateTo: "" });
    // No scope = unrestricted (NULL), no status = every closure.
    expect(dataCall().params).toEqual(["", "", "", null, ""]);
  });

  it("filters region, scope and status on the same recovered ASP code, newest first, capped", async () => {
    respond([]);
    await listCaseClosureDatesForAsp({ aspCode: "ASPS01511", dateFrom: "", dateTo: "" });
    const { sql } = dataCall();
    const aspExpr = "COALESCE(NULLIF(closure.work_location, ''), by_wo.loc, by_case.loc, '')";
    expect(sql).toContain(`(${"$"}1 = '' OR ${aspExpr} = ${"$"}1)`);
    expect(sql).toContain(`${aspExpr} = ANY(${"$"}4::text[])`);
    expect(sql).toContain("closure.closed_on >= $2::date");
    expect(sql).toContain("closure.closed_on <= $3::date");
    expect(sql).toContain("ORDER BY closure.closed_on DESC");
    expect(sql).toContain("LIMIT 2000");
  });
});

/**
 * The query-performance restructure (scope by date first, look up locations only for keys
 * that need one). Structural: these pin the SQL shape so the full-table `loc` cannot
 * silently come back. Whether Postgres returns the same rows, and how fast, needs a real
 * (restored, non-production) database.
 */
describe("closure-by-region SQL structure (performance restructure)", () => {
  const ASP = "COALESCE(NULLIF(closure.work_location, ''), by_wo.loc, by_case.loc, '')";

  async function summarySql(rawTable = true): Promise<string> {
    respond([], { rawTable });
    await summarizeCaseClosureDatesByAsp({ dateFrom: "2026-09-01", dateTo: "2026-09-30" });
    return dataCall().sql;
  }

  async function listSql(rawTable = true): Promise<string> {
    respond([], { rawTable });
    await listCaseClosureDatesForAsp({ aspCode: "ASPS01511", dateFrom: "2026-09-01", dateTo: "2026-09-30", statusGroup: "closed" });
    return dataCall().sql;
  }

  /** The text between two markers, so a test can assert what lives inside one CTE. */
  function between(sql: string, start: string, end: string): string {
    const i = sql.indexOf(start);
    const j = sql.indexOf(end, i + start.length);
    if (i < 0 || j < 0) throw new Error(`markers not found: ${start} .. ${end}`);
    return sql.slice(i, j);
  }

  it("filters closures by date in `scoped`, before any location lookup", async () => {
    const sql = await summarySql();
    const scoped = between(sql, "scoped AS (", "lookup_keys AS (");
    expect(scoped).toContain("FROM case_closure_dates closure");
    expect(scoped).toContain("closure.closed_on >= $1::date");
    expect(scoped).toContain("closure.closed_on <= $2::date");
    // case_closure_dates is read exactly once, inside `scoped`; everything else reads `scoped`.
    expect(sql.match(/FROM case_closure_dates\b/g)).toHaveLength(1);
    expect(sql).toContain("FROM scoped closure LEFT JOIN loc AS by_wo");
  });

  it("asks for a location only for closures whose own work location is blank", async () => {
    const keys = between(await summarySql(), "lookup_keys AS (", "loc AS (");
    expect(keys).toContain("FROM scoped closure");
    expect(keys).toContain("NULLIF(closure.work_location, '') IS NULL AND closure.wo_id <> ''");
    expect(keys).toContain("NULLIF(closure.work_location, '') IS NULL AND closure.case_id <> ''");
    // The same blank test the ASP expression starts with, so a row that needs no lookup gets none.
    expect(ASP.startsWith("COALESCE(NULLIF(closure.work_location, '')")).toBe(true);
  });

  it("restricts every location source to the needed keys (4 sources with the raw table, 2 without)", async () => {
    const withRaw = between(await summarySql(true), "loc AS (", "SELECT COALESCE(NULLIF(closure.work_location");
    expect(withRaw.match(/IN \(SELECT key FROM lookup_keys\)/g)).toHaveLength(4);
    expect(withRaw).toContain("UPPER(TRIM(ticket_id)) IN (SELECT key FROM lookup_keys)");
    expect(withRaw).toContain("UPPER(TRIM(case_id)) IN (SELECT key FROM lookup_keys)");
    expect(withRaw).toContain("ticket_no IN (SELECT key FROM lookup_keys)");
    expect(withRaw).toContain("WHERE case_id IN (SELECT key FROM lookup_keys)");

    mocks.query.mockReset();
    const withoutRaw = between(await summarySql(false), "loc AS (", "SELECT COALESCE(NULLIF(closure.work_location");
    expect(withoutRaw.match(/IN \(SELECT key FROM lookup_keys\)/g)).toHaveLength(2);
    expect(withoutRaw).not.toContain("flex_raw_records");
  });

  it("keeps one row per key in `loc`, so the LEFT JOINs can never multiply closures", async () => {
    const loc = between(await summarySql(), "loc AS (", "SELECT COALESCE(NULLIF(closure.work_location");
    expect(loc).toContain("SELECT key, MAX(loc) AS loc");
    expect(loc).toContain("GROUP BY key");
  });

  it("uses the ticket expression the migration-059 index covers", async () => {
    // daily_call_plan_report_rows_ticket_upper_id_idx is ON (UPPER(TRIM(ticket_id)), id DESC).
    expect(await summarySql()).toContain("UPPER(TRIM(ticket_id)) IN (SELECT key FROM lookup_keys)");
  });

  it("the record list scopes date AND status before the lookup, region after it", async () => {
    const sql = await listSql();
    const scoped = between(sql, "scoped AS (", "lookup_keys AS (");
    expect(scoped).toContain("closure.closed_on >= $2::date");
    expect(scoped).toContain("closure.closed_on <= $3::date");
    expect(scoped).toMatch(/\(\$5 = '' OR .+ = \$5\)/);
    // Region filters need the recovered ASP code, so they stay in the outer query.
    expect(scoped).not.toContain("$1");
    expect(scoped).not.toContain("$4");
    const outer = sql.slice(sql.indexOf("FROM scoped closure LEFT JOIN loc AS by_wo"));
    expect(outer).toContain(`($1 = '' OR ${ASP} = $1)`);
    expect(outer).toContain(`${ASP} = ANY($4::text[])`);
  });

  it("summary and record list share the same lookup CTEs", async () => {
    const fromSummary = between(await summarySql(), "lookup_keys AS (", "SELECT COALESCE(NULLIF(closure.work_location");
    mocks.query.mockReset();
    const fromList = between(await listSql(), "lookup_keys AS (", "SELECT closure.wo_id, closure.case_id,");
    expect(fromList.trim()).toBe(fromSummary.trim());
  });
});
