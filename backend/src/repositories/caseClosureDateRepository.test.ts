import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  mergeCaseClosureDates,
  replaceCaseClosureDates,
  type CaseClosureRecordInput,
} from "./caseClosureDateRepository.js";

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

beforeEach(() => {
  mocks.clientQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mocks.release.mockReset();
  mocks.connect.mockReset().mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.release,
  });
});

function record(overrides: Partial<CaseClosureRecordInput>): CaseClosureRecordInput {
  return {
    woId: "WO-1",
    caseId: "C-1",
    closureDate: "2026-07-31",
    closedOn: "2026-07-31",
    closureStatus: "WO Closed",
    statusRemarks: "",
    failureCode: "",
    resolutionComments: "",
    workLocation: "ASPS01461",
    aspName: "",
    activityTime: "2026-07-31T09:10:00+05:30",
    importSource: "AUTO",
    ...overrides,
  };
}

/** Every SQL string the transaction issued, whitespace-collapsed. */
function statements(): string[] {
  return mocks.clientQuery.mock.calls.map(([sql]) =>
    String(sql).replace(/\s+/g, " ").trim(),
  );
}

describe("mergeCaseClosureDates", () => {
  it("NEVER issues an unscoped DELETE — this is the erase-all-history regression", () => {
    // The hourly auto-sync sends only TODAY's work orders. Routing it through
    // `replaceCaseClosureDates` (which runs `DELETE FROM case_closure_dates` with no
    // WHERE) would throw every earlier day away on the first cycle.
    return mergeCaseClosureDates([record({ woId: "WO-A", caseId: "C-A" })]).then(() => {
      const deletes = statements().filter((sql) => sql.startsWith("DELETE"));
      expect(deletes).toHaveLength(1);
      expect(deletes[0]).toContain("WHERE");
      expect(deletes[0]).not.toMatch(/^DELETE FROM case_closure_dates$/);
    });
  });

  it("scopes the delete by work order, so a shared case is never swept up", async () => {
    // Was scoped by BOTH key sets, because 029 made case_id unique and a stale row
    // holding this batch's case would have broken the insert. After 065 that scoping is
    // destructive: a case legitimately carries several work orders, so deleting by case
    // would remove a sibling closed weeks earlier and outside this file's range — and
    // the insert, holding only this batch, would never put it back.
    await mergeCaseClosureDates([
      record({ woId: "WO-A", caseId: "C-A" }),
      record({ woId: "WO-B", caseId: "C-B" }),
    ]);

    const deleteCall = mocks.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("DELETE"),
    );
    expect(deleteCall).toBeDefined();
    const [sql, params] = deleteCall as [string, unknown[]];
    expect(sql.replace(/\s+/g, " ")).toContain("wo_id = ANY($1::text[])");
    expect(params[0]).toEqual(["WO-A", "WO-B"]);
    // Both rows carry their own work order, so nothing is matched by case.
    expect(params[1]).toEqual([]);
  });

  it("touches only the incoming keys, so untouched history survives", async () => {
    // Stand-in for the history test: import a 48-WO file, then merge a 13-WO today-only
    // file with ZERO key overlap. The merge must scope its delete to those 13 keys — it
    // is then arithmetically impossible for the other 48 to disappear.
    const today = Array.from({ length: 13 }, (_, i) =>
      record({ woId: `TODAY-${i}`, caseId: `TC-${i}` }),
    );

    const written = await mergeCaseClosureDates(today);

    expect(written).toBe(13);
    const deleteCall = mocks.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("DELETE"),
    ) as [string, unknown[]];
    expect(deleteCall[1][0]).toHaveLength(13);
    expect(statements().filter((sql) => sql.startsWith("INSERT"))).toHaveLength(13);
  });

  it("re-importing the same work order updates in place instead of colliding", async () => {
    // Delete-then-insert inside one transaction: the second import's DELETE removes the
    // existing row for that key before its INSERT, so a changed status never trips the
    // unique index.
    await mergeCaseClosureDates([
      record({ woId: "WO-A", caseId: "C-A", closureStatus: "Closed - Canceled" }),
    ]);

    const sqls = statements();
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toContain("DELETE");
    expect(sqls[2]).toContain("INSERT INTO case_closure_dates");
    expect(sqls[sqls.length - 1]).toBe("COMMIT");

    const insertParams = mocks.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT"),
    )?.[1] as unknown[];
    expect(insertParams[0]).toBe("WO-A");
    expect(insertParams[4]).toBe("Closed - Canceled");
  });

  it("keeps a NULL closure date rather than dropping the row", async () => {
    await mergeCaseClosureDates([
      record({ closureDate: null, closedOn: "2026-07-31", closureStatus: "Closed - Canceled" }),
    ]);

    const insertParams = mocks.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT"),
    )?.[1] as unknown[];
    expect(insertParams[2]).toBeNull(); // closure_date
    expect(insertParams[3]).toBe("2026-07-31"); // closed_on
  });

  it("does nothing at all for an empty batch", async () => {
    expect(await mergeCaseClosureDates([])).toBe(0);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("drops a repeated WORK ORDER, but keeps a second work order on one case", async () => {
    // Was: any reused key was dropped, because 029 made case_id unique too. That
    // discarded 19 real closures per cycle on prod — a customer calling back gets a new
    // work order on the same case, and Flex closes that one as well. 065 removed the
    // index; identity is the work order alone.
    const written = await mergeCaseClosureDates([
      record({ woId: "WO-A", caseId: "C-A" }),
      record({ woId: "WO-B", caseId: "C-A" }), // same case, different job — KEEP
      record({ woId: "WO-A", caseId: "C-C" }), // same work order — genuine duplicate
    ]);

    expect(written).toBe(2);
  });
});

describe("replaceCaseClosureDates", () => {
  it("still wipes the whole table — the manual import button is unchanged", async () => {
    await replaceCaseClosureDates([record({})]);

    const deletes = statements().filter((sql) => sql.startsWith("DELETE"));
    expect(deletes).toEqual(["DELETE FROM case_closure_dates"]);
  });

  it("refuses to wipe the table for an empty batch", async () => {
    // The DELETE is unconditional, so a file that parsed to no usable rows — a
    // headers-only morning export, a truncated download, unexpected column names —
    // used to destroy the entire closure history and put nothing back. It emptied
    // production on 2026-08-01.
    expect(await replaceCaseClosureDates([])).toBe(0);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("refuses when every row is unusable, not just when the list is empty", async () => {
    // dedupeByBothKeys drops rows with no key at all, so a workbook whose Ticket No
    // and Case Id columns did not parse arrives here non-empty but reduces to nothing.
    expect(
      await replaceCaseClosureDates([record({ woId: "", caseId: "" })]),
    ).toBe(0);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});

describe("a Case Id carrying several work orders (migration 065)", () => {
  /**
   * Production shapes from 2026-08-28. Before 065 these were rejected outright: 19
   * completed, billable closures discarded on every import for no reason but a shared
   * case.
   */
  it("stores every work order on one case instead of dropping the later ones", async () => {
    await mergeCaseClosureDates([
      record({ woId: "WO-035340079", caseId: "5162524657" }),
      record({ woId: "WO-035252057", caseId: "5162524657" }),
      record({ woId: "WO-035372074", caseId: "5162524657" }),
    ]);

    const inserts = mocks.clientQuery.mock.calls.filter((c) =>
      String(c[0]).startsWith("INSERT INTO case_closure_dates"),
    );
    expect(inserts).toHaveLength(3);
  });

  it("keeps a revisit filed as -1 as its own work order", async () => {
    const written = await mergeCaseClosureDates([
      record({ woId: "WO-035260625", caseId: "5162554102" }),
      record({ woId: "WO-035260625-1", caseId: "5162554102" }),
    ]);
    expect(written).toBe(2);
  });

  it("still collapses a genuine duplicate of the SAME work order", async () => {
    const written = await mergeCaseClosureDates([
      record({ woId: "WO-1", caseId: "C-1" }),
      record({ woId: "WO-1", caseId: "C-1" }),
    ]);
    expect(written).toBe(1);
  });

  it("scopes the merge delete to work orders, never to shared cases", async () => {
    // The destructive shape this guards: a rolling import holding WO-A must not delete
    // its sibling WO-B, which shares the case but is outside this file's date range.
    await mergeCaseClosureDates([record({ woId: "WO-A", caseId: "SHARED" })]);

    const del = mocks.clientQuery.mock.calls.find((c) =>
      String(c[0]).includes("DELETE FROM case_closure_dates"),
    );
    expect(del).toBeDefined();
    const [sql, params] = del as [string, unknown[]];
    expect(sql).toContain("wo_id = ANY($1::text[])");
    expect(params[0]).toEqual(["WO-A"]);
    // The case set carries ONLY rows that have no work order of their own.
    expect(params[1]).toEqual([]);
  });

  it("still matches a keyless row by its case id", async () => {
    await mergeCaseClosureDates([record({ woId: "", caseId: "ONLY-CASE" })]);
    const del = mocks.clientQuery.mock.calls.find((c) =>
      String(c[0]).includes("DELETE FROM case_closure_dates"),
    );
    const [, params] = del as [string, unknown[]];
    expect(params[0]).toEqual([]);
    expect(params[1]).toEqual(["ONLY-CASE"]);
  });

  it("cannot tell two keyless rows on one case apart, so keeps one", async () => {
    const written = await mergeCaseClosureDates([
      record({ woId: "", caseId: "SAME" }),
      record({ woId: "", caseId: "SAME" }),
    ]);
    expect(written).toBe(1);
  });
});
