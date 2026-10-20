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
