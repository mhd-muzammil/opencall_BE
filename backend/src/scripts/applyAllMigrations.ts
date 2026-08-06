// Run every migration, in order — the post-deploy step.
//
// A Dokploy deploy ships code but runs no migrations. On 2026-08-06 that gap
// took production down: migration 040 adds evening_rtpl_status_updated_at, the
// report-row repository selects it in six places, and with the column missing
// report history, report generation and engineer productivity all answered 500.
// Running one command after every deploy is what stops that recurring.
//
//   node dist/scripts/applyAllMigrations.js     (production — no pnpm/tsx there)
//   npm run migrate:all                         (development)
//
// Safe to run on EVERY deploy, including when nothing is pending: each script
// guards its own DDL, so an already-applied migration is a no-op.
//
// Each migration runs as its own child process rather than being imported,
// because every apply*Migration script self-executes and closes the connection
// pool when it finishes — importing them in sequence would leave the second one
// without a pool. A child process per migration also means one failure cannot
// leave a half-open pool behind, and the output is identical to running them by
// hand, which is how they have always been run.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIGRATIONS_NEEDING_REPO_SQL,
  MIGRATION_SCRIPTS,
} from "./migrationOrder.js";

const selfPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(selfPath);
// Same depth from src/scripts and dist/scripts alike: both sit two levels below
// `backend`, so three up is the repo root. Absent in the deploy image.
const migrationSqlDir = path.resolve(
  scriptDir,
  "../../../infra/postgres/migrations",
);
const hasRepoSql = existsSync(migrationSqlDir);
// ".js" when running the compiled build (production), ".ts" under tsx (dev).
// Siblings are invoked the same way this script was, so one command works in
// both places without the caller choosing.
const scriptExtension = path.extname(selfPath);

function runMigration(name: string): Promise<number> {
  const target = path.join(scriptDir, `${name}${scriptExtension}`);
  const args =
    scriptExtension === ".ts" ? ["--import", "tsx", target] : [target];

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (error) => {
      console.error(`Could not start ${name}:`, error);
      resolve(1);
    });
  });
}

async function run(): Promise<void> {
  const total = MIGRATION_SCRIPTS.length;
  console.log(`Applying ${total} migrations...\n`);
  if (!hasRepoSql) {
    console.log(
      `Bootstrap migrations (005-015) will be skipped: their SQL lives in\n` +
        `infra/postgres/migrations, which is not in the deploy image. Those\n` +
        `tables are in the healthcheck's REQUIRED_TABLES, so a box serving\n` +
        `/health/runtime with ok:true has already applied them.\n`,
    );
  }

  let applied = 0;
  let skipped = 0;

  for (const [index, name] of MIGRATION_SCRIPTS.entries()) {
    const position = `[${index + 1}/${total}]`;

    if (!hasRepoSql && MIGRATIONS_NEEDING_REPO_SQL.has(name)) {
      console.log(`${position} ${name} — SKIPPED (needs repo SQL)`);
      skipped += 1;
      continue;
    }

    console.log(`${position} ${name}`);

    const exitCode = await runMigration(name);
    if (exitCode !== 0) {
      // Stop rather than continue: migrations build on each other, so running
      // the rest against a schema that failed halfway turns one clear error
      // into a cascade of confusing ones. Everything before this point IS
      // applied — fix the cause and re-run; the completed ones no-op.
      console.error(
        `\n${position} ${name} FAILED (exit ${exitCode}). Stopping.\n` +
          `${applied} migration(s) applied. Re-run this command after fixing the cause.`,
      );
      process.exitCode = 1;
      return;
    }
    applied += 1;
  }

  console.log(
    `\nDone: ${applied} migration(s) applied${skipped > 0 ? `, ${skipped} skipped` : ""}.`,
  );
}

void run();
