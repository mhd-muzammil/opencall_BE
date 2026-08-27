import { describe, expect, it } from "vitest";
import { resolveClosureImportMode } from "./closureDateController.js";

/**
 * On 2026-08-27 a manual import of a partial closure export emptied three weeks
 * of history: the import button sent no `mode`, the server read "not merge" as
 * "replace", and replace does an unconditional DELETE before loading the file.
 * The dashboard then reported no calls closed on days that had 40-50 closures.
 *
 * These pin the rule that prevents it: nothing merges by accident, and nothing
 * WIPES by accident either — only the caller who names `replace` gets it.
 */
describe("resolveClosureImportMode", () => {
  it("merges when no mode is given at all", () => {
    // The exact shape of the incident: an older client, or any caller that
    // simply does not think about it.
    expect(resolveClosureImportMode(undefined)).toBe("merge");
    expect(resolveClosureImportMode(null)).toBe("merge");
    expect(resolveClosureImportMode("")).toBe("merge");
  });

  it("replaces only when asked for by name", () => {
    expect(resolveClosureImportMode("replace")).toBe("replace");
    expect(resolveClosureImportMode(" REPLACE ")).toBe("replace");
  });

  it("merges on anything it does not recognise, including near misses", () => {
    // A typo must not be read as permission to delete the table.
    for (const value of ["replce", "REPLACE ALL", "overwrite", "true", "1", {}]) {
      expect(resolveClosureImportMode(value)).toBe("merge");
    }
  });

  it("still honours an explicit merge", () => {
    expect(resolveClosureImportMode("merge")).toBe("merge");
    expect(resolveClosureImportMode(" Merge ")).toBe("merge");
  });
});
