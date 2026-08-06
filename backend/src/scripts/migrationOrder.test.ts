import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MIGRATIONS_NEEDING_REPO_SQL,
  MIGRATION_SCRIPTS,
} from "./migrationOrder.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

/** Every apply*Migration script that exists on disk. */
function migrationScriptsOnDisk(): string[] {
  return readdirSync(scriptDir)
    .filter((file) => /^apply.*Migration\.ts$/.test(file))
    .map((file) => file.replace(/\.ts$/, ""))
    .filter((name) => name !== "applyAllMigrations");
}

describe("MIGRATION_SCRIPTS", () => {
  /**
   * The guard that matters. A migration script that exists but is not listed
   * never runs on deploy — which is exactly how production ended up without
   * migration 040 on 2026-08-06, with three pages answering 500 while the
   * healthcheck reported ready. Adding a migration must break this test until
   * it is registered.
   */
  it("lists every apply*Migration script in this directory", () => {
    const onDisk = migrationScriptsOnDisk().sort();
    const listed = [...MIGRATION_SCRIPTS].sort();

    const unlisted = onDisk.filter((name) => !listed.includes(name));
    expect(
      unlisted,
      `These migration scripts are not in MIGRATION_SCRIPTS and would never run on deploy: ${unlisted.join(", ")}`,
    ).toEqual([]);
  });

  it("does not name a script that no longer exists", () => {
    const onDisk = migrationScriptsOnDisk();
    const missing = MIGRATION_SCRIPTS.filter((name) => !onDisk.includes(name));
    expect(
      missing,
      `MIGRATION_SCRIPTS names scripts that are not on disk: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("has no duplicates", () => {
    expect(new Set(MIGRATION_SCRIPTS).size).toBe(MIGRATION_SCRIPTS.length);
  });

  it("flags exactly the scripts that read SQL from the repo", () => {
    // Derived from the source rather than restated: a script switched to inline
    // SQL (or a new one added that reads from disk) must not silently disagree
    // with the skip list, or the runner skips something it should run.
    const readsFromDisk = migrationScriptsOnDisk()
      .filter((name) =>
        readFileSync(path.join(scriptDir, `${name}.ts`), "utf8").includes(
          "readFileSync",
        ),
      )
      .sort();

    expect([...MIGRATIONS_NEEDING_REPO_SQL].sort()).toEqual(readsFromDisk);
  });

  it("only flags bootstrap migrations as needing repo SQL", () => {
    // The skip is justified by those tables being in the healthcheck's
    // REQUIRED_TABLES, which is only true for the early bootstrap set. A later
    // migration must never be skippable on this basis.
    for (const name of MIGRATIONS_NEEDING_REPO_SQL) {
      expect(MIGRATION_SCRIPTS.indexOf(name)).toBeLessThan(
        MIGRATION_SCRIPTS.indexOf("applyEngineersMigration"),
      );
    }
  });

  it("keeps migrations after the tables they depend on", () => {
    const at = (name: string) => MIGRATION_SCRIPTS.indexOf(name);

    // engineers FKs regions(id) — regions are seeded by 015.
    expect(at("applyEngineersMigration")).toBeGreaterThan(
      at("applyRequiredRegionSeedMigration"),
    );
    // 026/027 extend the special-access tables created by 023.
    expect(at("applySpecialAccessEditMigration")).toBeGreaterThan(
      at("applySpecialAccessMigration"),
    );
    // renewal_leads.updated_by FKs users(id).
    expect(at("applyRenewalLeadsMigration")).toBeGreaterThan(
      at("applyUserManagementMigration"),
    );
  });
});
