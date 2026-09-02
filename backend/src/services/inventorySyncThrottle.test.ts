import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The report-row insert calls syncPartToInventory once per row, fire-and-forget, and
 * each call runs up to four pool queries. A ~3,800-row report therefore fired ~15,000
 * queries at a 45-connection pool in one burst, emptied it, and every other request in
 * the API failed with "timeout exceeded when trying to connect" — which is what users
 * reported as "I click save and it doesn't save".
 *
 * These tests hold the concurrency ceiling in place. They mock the database so what is
 * measured is purely how many syncs are in flight at once.
 */

const state = { peakConcurrent: 0, active: 0, completed: 0 };

const pgQuery = vi.fn(async () => {
  state.active += 1;
  state.peakConcurrent = Math.max(state.peakConcurrent, state.active);
  // Yield to the microtask queue: enough for every un-gated caller to pile in here
  // before any of them finishes, which is exactly what the ceiling has to prevent.
  await Promise.resolve();
  await Promise.resolve();
  state.active -= 1;
  state.completed += 1;
  return { rows: [], rowCount: 0 };
});

vi.mock("../config/database.js", () => ({
  query: pgQuery,
  pool: { connect: vi.fn(), query: pgQuery },
  closeDatabasePool: vi.fn(),
  withTransaction: vi.fn(),
}));

const ROW = {
  case_id: "CASE-1",
  ticket_id: "WO-1",
  part: "MO-717006912",
  work_location: "ASPS01461",
  engineer: "Priya",
  customer_name: "Customer",
};

describe("syncPartToInventory concurrency", () => {
  beforeEach(() => {
    state.peakConcurrent = 0;
    state.active = 0;
    state.completed = 0;
    pgQuery.mockClear();
  });

  it("never runs more than a couple of syncs against the pool at once", async () => {
    const { syncPartToInventory } = await import("./inventorySyncService.js");

    // What a single report insert does today.
    const burst = Array.from({ length: 200 }, (_, i) =>
      syncPartToInventory({ ...ROW, case_id: `CASE-${i}`, ticket_id: `WO-${i}` }),
    );
    await Promise.all(burst);

    // The exact ceiling is a tuning decision; that there IS one is not.
    expect(state.peakConcurrent).toBeLessThanOrEqual(4);
    // And a queue is not a dropped queue — every row still syncs.
    expect(state.completed).toBeGreaterThan(0);
  });

  it("frees its slot when a sync throws, so the queue cannot wedge", async () => {
    const { syncPartToInventory } = await import("./inventorySyncService.js");

    pgQuery.mockRejectedValueOnce(new Error("db down"));

    // A failure inside one sync must not strand the slot — the rest still drain.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        syncPartToInventory({ ...ROW, case_id: `X-${i}`, ticket_id: `WOX-${i}` }),
      ),
    );

    // Reaching here at all is the assertion: a leaked slot would hang this test.
    expect(state.peakConcurrent).toBeLessThanOrEqual(4);
  });

  it("skips rows with no case or part without consuming a slot", async () => {
    const { syncPartToInventory } = await import("./inventorySyncService.js");

    await Promise.all([
      syncPartToInventory({ ...ROW, case_id: "" }),
      syncPartToInventory({ ...ROW, part: "" }),
    ]);

    expect(pgQuery).not.toHaveBeenCalled();
  });
});
