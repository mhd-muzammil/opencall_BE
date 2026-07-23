import { describe, expect, it } from "vitest";
import {
  dedupeCaseParts,
  findItemForPart,
  itemMatchesPart,
  partIdentity,
  type CasePartNumbers,
} from "./inventorySyncService.js";

const part = (
  partOrderNumber: string,
  goodPartNumber = "",
  soNumber = "",
): CasePartNumbers => ({ goodPartNumber, partOrderNumber, soNumber });

describe("partIdentity", () => {
  it("uses Part Order No, falls back to Good Part No, case/space-insensitive", () => {
    expect(partIdentity(part("MO-717006912"))).toBe("mo-717006912");
    expect(partIdentity(part("", "L40098-001"))).toBe("l40098-001");
    expect(partIdentity(part("  MO-1  "))).toBe("mo-1");
    expect(partIdentity(part("", ""))).toBe("");
  });
});

describe("dedupeCaseParts", () => {
  it("keeps every distinct part of a multi-part case (the WO-035172274 shape)", () => {
    const parts = dedupeCaseParts([
      part("MO-717006912", "L40098-001"),
      part("MO-716945726", "P13341-601"),
    ]);
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.partOrderNumber)).toEqual([
      "MO-717006912",
      "MO-716945726",
    ]);
  });

  it("collapses true duplicates (same part order number)", () => {
    const parts = dedupeCaseParts([
      part("MO-1", "GP-1"),
      part("MO-1", "GP-1"),
      part("mo-1", "GP-1"),
    ]);
    expect(parts).toHaveLength(1);
  });

  it("keeps at most one unkeyed (no-number) part so a case never loses its row", () => {
    expect(dedupeCaseParts([part(""), part("")])).toHaveLength(1);
    const mixed = dedupeCaseParts([part(""), part("MO-9")]);
    expect(mixed).toHaveLength(2);
  });
});

describe("itemMatchesPart", () => {
  it("matches an item to a part by Part Order No", () => {
    expect(
      itemMatchesPart(
        { part_order_number: "MO-716945726", good_part_number: "P13341-601" },
        part("MO-716945726", "P13341-601"),
      ),
    ).toBe(true);
    expect(
      itemMatchesPart(
        { part_order_number: "MO-717006912", good_part_number: "L40098-001" },
        part("MO-716945726", "P13341-601"),
      ),
    ).toBe(false);
  });

  it("a no-Part-Order part matches an order-less item by Good Part No", () => {
    expect(
      itemMatchesPart(
        { part_order_number: "", good_part_number: "L40098-001" },
        part("", "L40098-001"),
      ),
    ).toBe(true);
    // but not an item that already has a Part Order No
    expect(
      itemMatchesPart(
        { part_order_number: "MO-1", good_part_number: "L40098-001" },
        part("", "L40098-001"),
      ),
    ).toBe(false);
  });

  it("the missing part of a half-synced case is detected as unmatched", () => {
    // Case already has the POD part; the SHIPPED part was dropped by the old sync.
    const existing = [
      { part_order_number: "MO-716945726", good_part_number: "P13341-601" },
    ];
    const allParts = [
      part("MO-717006912", "L40098-001"),
      part("MO-716945726", "P13341-601"),
    ];
    const missing = allParts.filter(
      (p) => !existing.some((it) => itemMatchesPart(it, p)),
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]?.partOrderNumber).toBe("MO-717006912");
  });
});

describe("findItemForPart — unkeyed parts adopt, never duplicate", () => {
  const items = [
    { id: 1, part_order_number: "MO-716945726", good_part_number: "P13341-601" },
  ];

  it("a keyed part matches its item by identity", () => {
    const hit = findItemForPart(items, part("MO-716945726", "P13341-601"), () => false);
    expect(hit?.id).toBe(1);
    const miss = findItemForPart(items, part("MO-717006912", "L40098-001"), () => false);
    expect(miss).toBeUndefined();
  });

  it("an unkeyed (no-number) part ADOPTS the existing item instead of adding a blank", () => {
    // The regression behind the "(no number)" backfill junk: an unkeyed part
    // must reuse the case's item, not create a second blank one.
    const adopted = findItemForPart(items, part("", ""), () => false);
    expect(adopted?.id).toBe(1);
  });

  it("an unkeyed part with NO unclaimed item is unmatched (caller creates only if the case is empty)", () => {
    expect(findItemForPart(items, part("", ""), (it) => it.id === 1)).toBeUndefined();
    expect(findItemForPart([], part("", ""), () => false)).toBeUndefined();
  });
});
