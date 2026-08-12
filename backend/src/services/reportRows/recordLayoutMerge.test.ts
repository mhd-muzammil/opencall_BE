import { describe, expect, it } from "vitest";
import { mergeNewStandardColumns } from "./recordLayoutMerge.js";

const STANDARD = ["S.no", "Ticket ID", "Location", "Engineer", "Distance"];

describe("mergeNewStandardColumns", () => {
  it("appends a column added after the layout was saved", () => {
    const merged = mergeNewStandardColumns({
      orderedColumns: ["S.no", "Ticket ID", "Location", "Engineer"],
      knownColumns: ["S.no", "Ticket ID", "Location", "Engineer"],
      standardColumns: STANDARD,
    });

    expect(merged).toEqual(["S.no", "Ticket ID", "Location", "Engineer", "Distance"]);
  });

  it("keeps a deliberately hidden column hidden", () => {
    const merged = mergeNewStandardColumns({
      orderedColumns: ["S.no", "Ticket ID"],
      // The user could see Location and Engineer and chose to remove them.
      knownColumns: ["S.no", "Ticket ID", "Location", "Engineer"],
      standardColumns: STANDARD,
    });

    expect(merged).toEqual(["S.no", "Ticket ID", "Distance"]);
    expect(merged).not.toContain("Location");
  });

  it("preserves the user's own column order", () => {
    const merged = mergeNewStandardColumns({
      orderedColumns: ["Engineer", "Location", "S.no"],
      knownColumns: ["S.no", "Ticket ID", "Location", "Engineer"],
      standardColumns: STANDARD,
    });

    expect(merged.slice(0, 3)).toEqual(["Engineer", "Location", "S.no"]);
  });

  it("appends everything missing for a legacy layout with no catalog", () => {
    // Nothing can be proven about intent here, and a column nobody can see is
    // worse than one that has to be re-hidden.
    const merged = mergeNewStandardColumns({
      orderedColumns: ["S.no", "Ticket ID"],
      knownColumns: null,
      standardColumns: STANDARD,
    });

    expect(merged).toEqual(["S.no", "Ticket ID", "Location", "Engineer", "Distance"]);
  });

  it("leaves a fully up-to-date layout untouched", () => {
    const ordered = ["S.no", "Ticket ID", "Location", "Engineer", "Distance"];
    const merged = mergeNewStandardColumns({
      orderedColumns: ordered,
      knownColumns: STANDARD,
      standardColumns: STANDARD,
    });

    expect(merged).toEqual(ordered);
  });

  it("keeps raw Excel columns the user added, which are not standard columns", () => {
    const merged = mergeNewStandardColumns({
      orderedColumns: ["S.no", "Customer Pincode", "Ticket ID"],
      knownColumns: ["S.no", "Ticket ID", "Location", "Engineer", "Customer Pincode"],
      standardColumns: STANDARD,
    });

    expect(merged).toContain("Customer Pincode");
    expect(merged).toEqual(["S.no", "Customer Pincode", "Ticket ID", "Distance"]);
  });

  it("does not duplicate a column already visible", () => {
    const merged = mergeNewStandardColumns({
      orderedColumns: ["Distance", "S.no"],
      knownColumns: null,
      standardColumns: STANDARD,
    });

    expect(merged.filter((c) => c === "Distance")).toHaveLength(1);
  });
});
