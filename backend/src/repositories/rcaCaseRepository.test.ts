import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RCA_RECENCY_DAYS, listOpenRcaCases } from "./rcaCaseRepository.js";

/**
 * The open-RCA-case query, as the repository builds it.
 *
 * `query` is mocked: these tests pin the parameters and the clauses that decide which
 * rows are eligible. They do NOT run the SQL, so they cannot prove Postgres returns the
 * same rows or uses an index — that needs a restored non-production database.
 */

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../config/database.js", () => ({ query: mocks.query }));

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
});

function lastCall(): { sql: string; params: unknown[] } {
  const call = mocks.query.mock.calls.at(-1);
  if (!call) throw new Error("no query issued");
  return { sql: String(call[0]).replace(/\s+/g, " ").trim(), params: call[1] as unknown[] };
}

describe("listOpenRcaCases — parameters and eligibility", () => {
  it("returns the database rows unchanged", async () => {
    const rows = [{ ticket_id: "WO-1", ticket_key: "WO-1" }];
    mocks.query.mockResolvedValueOnce({ rows });
    expect(await listOpenRcaCases({})).toBe(rows);
  });

  it("defaults the recency window and never lets it fall below one day", async () => {
    await listOpenRcaCases({});
    expect(lastCall().params[0]).toBe(DEFAULT_RCA_RECENCY_DAYS);

    await listOpenRcaCases({ recencyDays: 0 });
    expect(lastCall().params[0]).toBe(1);

    await listOpenRcaCases({ recencyDays: 30 });
    expect(lastCall().params[0]).toBe(30);
  });

  it("scopes by work location, normalised to trimmed upper-case codes", async () => {
    await listOpenRcaCases({ workLocations: [" asps01511 ", "ASPS01461"] });
    const { sql, params } = lastCall();
    expect(params[1]).toEqual(["ASPS01511", "ASPS01461"]);
    expect(sql).toContain("UPPER(TRIM(COALESCE(rows.work_location, ''))) = ANY($2::text[])");
  });

  it("does not scope at all for an unrestricted caller (null or empty list)", async () => {
    await listOpenRcaCases({ workLocations: null });
    expect(lastCall().sql).not.toContain("rows.work_location, ''))) = ANY");
    expect(lastCall().params).toHaveLength(1);

    await listOpenRcaCases({ workLocations: [] });
    expect(lastCall().sql).not.toContain("rows.work_location, ''))) = ANY");
  });

  it("searches ticket, case, customer and account with one trimmed wildcard parameter", async () => {
    await listOpenRcaCases({ search: "  acme  " });
    const { sql, params } = lastCall();
    expect(params[1]).toBe("%acme%");
    for (const column of ["rows.ticket_id ILIKE $2", "COALESCE(rows.case_id, '') ILIKE $2", "COALESCE(rows.customer_name, '') ILIKE $2", "COALESCE(rows.account_name, '') ILIKE $2"]) {
      expect(sql).toContain(column);
    }
  });

  it("numbers parameters in order when region and search are combined", async () => {
    await listOpenRcaCases({ workLocations: ["ASPS01511"], search: "x", recencyDays: 7 });
    const { sql, params } = lastCall();
    expect(params).toEqual([7, ["ASPS01511"], "%x%"]);
    expect(sql).toContain("= ANY($2::text[])");
    expect(sql).toContain("ILIKE $3");
  });

  it("applies region and search to the open cases only, never to their history", async () => {
    // A case's history spans every report it appeared in; scoping the history by region
    // or search would change last-action / appearance counts for cases that moved.
    await listOpenRcaCases({ workLocations: ["ASPS01511"], search: "x" });
    const { sql } = lastCall();
    expect(sql.match(/rows\.work_location, ''\)\)\) = ANY/g)).toHaveLength(1);
    expect(sql.match(/rows\.ticket_id ILIKE/g)).toHaveLength(1);
  });

  it("keeps a non-blank ticket requirement and returns cases ordered by ticket id", async () => {
    await listOpenRcaCases({});
    const { sql } = lastCall();
    expect(sql).toContain("NULLIF(TRIM(rows.ticket_id), '') IS NOT NULL");
    expect(sql).toMatch(/ORDER BY lr\.ticket_id ASC$/);
  });
});

/**
 * The query-performance restructure: read each open case's history once, by the indexed
 * ticket expression, and share it. Structural only — equivalence of the returned rows and
 * the actual plan/timing need a real (restored, non-production) database.
 */
describe("open-case history SQL structure (performance restructure)", () => {
  async function sql(filters: Parameters<typeof listOpenRcaCases>[0] = {}): Promise<string> {
    await listOpenRcaCases(filters);
    return lastCall().sql;
  }

  /** One CTE's text: from "<name> AS (" to just before the next CTE or the final SELECT. */
  function cte(text: string, name: string): string {
    const start = text.indexOf(`${name} AS (`);
    if (start < 0) throw new Error(`CTE ${name} not found`);
    const rest = text.slice(start + name.length);
    const end = rest.search(/\),\s+(?:-- [^\n]*?\s+)*\w+ AS \(|\)\s+SELECT\s+lr\.\*/);
    if (end < 0) throw new Error(`end of CTE ${name} not found`);
    return text.slice(start, start + name.length + end + 1);
  }

  it("reads the report rows for history exactly once, in case_history", async () => {
    const text = await sql();
    // One JOIN for today's open rows (latest_rows_raw), one FROM for all their history.
    expect(text.match(/daily_call_plan_report_rows\b/g)).toHaveLength(2);
    expect(cte(text, "case_history")).toContain("FROM daily_call_plan_report_rows r");
  });

  it("fetches history by = ANY over the open cases' keys on the indexed ticket expression", async () => {
    // daily_call_plan_report_rows_ticket_upper_id_idx is ON (UPPER(TRIM(ticket_id)), id DESC).
    expect(cte(await sql(), "case_history")).toContain(
      "WHERE UPPER(TRIM(r.ticket_id)) = ANY(ARRAY(SELECT ticket_key FROM latest_rows))",
    );
  });

  it("feeds both the appearance diff and the last actor from the shared history", async () => {
    const text = await sql();
    expect(cte(text, "appearance_diffs")).toContain("FROM case_history");
    expect(cte(text, "appearance_diffs")).not.toContain("daily_call_plan_report_rows");
    expect(cte(text, "last_actor")).toContain("FROM case_history h");
    expect(cte(text, "last_actor")).not.toContain("daily_call_plan_report_rows");
  });

  it("keeps the appearance order and the definition of an action unchanged", async () => {
    const text = await sql();
    expect(cte(text, "appearance_diffs")).toContain(
      "LAG(cur_state) OVER ( PARTITION BY ticket_key ORDER BY report_date ASC, report_created_at ASC, row_id ASC )",
    );
    const agg = cte(text, "history_agg");
    expect(agg).toContain("WHEN updated_at IS NOT NULL OR prev_state IS NULL OR cur_state IS DISTINCT FROM prev_state");
    expect(agg).toContain("COUNT(DISTINCT report_date)::int AS total_appearances");
    expect(agg).toContain("MIN(report_date)::text AS first_seen_date");
  });

  it("tracks the same operator-editable fields as before (ten, in order)", async () => {
    const history = cte(await sql(), "case_history");
    const fields = ["r.rtpl_status", "r.segment", "r.engineer", "r.location", "r.case_created_time", "r.hp_owner_status", "r.customer_mail", "r.rca", "r.remarks", "r.manual_notes"];
    let at = history.indexOf("ROW(");
    for (const field of fields) {
      const next = history.indexOf(field, at + 1);
      expect(next, field).toBeGreaterThan(at);
      at = next;
    }
  });

  it("picks the last actor by latest edit, breaking exact ties by row id", async () => {
    const actor = cte(await sql(), "last_actor");
    expect(actor).toContain("WHERE h.updated_at IS NOT NULL AND h.updated_by IS NOT NULL");
    expect(actor).toContain("ORDER BY h.ticket_key, h.updated_at DESC, h.row_id DESC");
  });

  it("still never region- or search-filters the history", async () => {
    const history = cte(await sql({ workLocations: ["ASPS01511"], search: "x" }), "case_history");
    expect(history).not.toContain("work_location");
    expect(history).not.toContain("ILIKE");
  });
});
