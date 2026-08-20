import { describe, it, expect } from "vitest";
import { pendingUids } from "./inboundEmailService.js";

/**
 * The sweep's backlog arithmetic.
 *
 * The IMAP SEARCH is bounded by a watermark that never moves, so every sweep is offered the
 * whole range again — hundreds of messages once a mailbox falls a few days behind. What
 * makes a bounded batch drain that backlog rather than circle it is subtracting the UIDs
 * already stored BEFORE the cap is applied; get that wrong and the sweep re-reads the same
 * oldest forty messages for ever while today's mail never arrives.
 */
describe("pendingUids", () => {
  it("drops UIDs already stored", () => {
    expect(pendingUids([1, 2, 3, 4, 5], new Set([2, 4]))).toEqual([1, 3, 5]);
  });

  it("returns everything when nothing is stored yet", () => {
    expect(pendingUids([7, 8, 9], new Set())).toEqual([7, 8, 9]);
  });

  it("returns nothing when the mailbox is fully caught up", () => {
    expect(pendingUids([1, 2, 3], new Set([1, 2, 3]))).toEqual([]);
  });

  it("orders oldest first so a capped batch catches up in arrival order", () => {
    expect(pendingUids([30, 10, 20], new Set())).toEqual([10, 20, 30]);
  });

  it("accepts the string UIDs some IMAP servers return", () => {
    expect(pendingUids(["10", "11", "12"], new Set([11]))).toEqual([10, 12]);
  });

  it("ignores values that are not UIDs at all", () => {
    expect(pendingUids([1, "", "abc", 3], new Set())).toEqual([1, 3]);
  });

  it("collapses a UID the server lists twice", () => {
    expect(pendingUids([5, 5, 6], new Set())).toEqual([5, 6]);
  });

  it("leaves the newest mail for a later sweep once the batch is capped", () => {
    // 200 waiting, 40 to a sweep: the first sweep takes the oldest 40 and the next sweep
    // sees 160 still pending — strictly further ahead each time, which is what stops the
    // worker from meeting the same backlog after every restart.
    const offered = Array.from({ length: 200 }, (_, i) => i + 1);
    const first = pendingUids(offered, new Set()).slice(0, 40);
    expect(first).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));

    const afterFirst = pendingUids(offered, new Set(first));
    expect(afterFirst).toHaveLength(160);
    expect(afterFirst[0]).toBe(41);
  });
});
