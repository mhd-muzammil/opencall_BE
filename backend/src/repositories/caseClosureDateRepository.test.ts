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

  it("scopes the delete by BOTH key sets, or the insert violates the case_id index", async () => {
    // The table carries two partial unique indexes (wo_id AND case_id), so a single
    // ON CONFLICT target cannot cover both. Deleting by wo_id alone would leave a stale
    // row holding this batch's case_id.
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
    expect(sql.replace(/\s+/g, " ")).toContain("case_id = ANY($2::text[])");
    expect(params[0]).toEqual(["WO-A", "WO-B"]);
    expect(params[1]).toEqual(["C-A", "C-B"]);
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

  it("drops a later row that reuses a key already taken, guarding both indexes", async () => {
    const written = await mergeCaseClosureDates([
      record({ woId: "WO-A", caseId: "C-A" }),
      record({ woId: "WO-B", caseId: "C-A" }), // case id already used
      record({ woId: "WO-A", caseId: "C-C" }), // wo id already used
    ]);

    expect(written).toBe(1);
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
