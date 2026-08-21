import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabasePool, pool } from "../config/database.js";

/**
 * Run the migrations before the API starts, so a deploy cannot leave the schema behind.
 *
 * Every outage this system has had of the shape "a page 500s and /health says ready" came
 * from the same gap: the code shipped and the migration did not, because applying it was a
 * separate thing somebody had to remember. Closing that gap is the whole point.
 *
 * FOUR THINGS MAKE THIS SAFE TO PUT IN FRONT OF THE SERVER:
 *
 * 1. A kill switch. Off unless RUN_MIGRATIONS_ON_START is "true", so it can be turned off
 *    from the Dokploy environment in seconds without a deploy or a code change. A safety
 *    mechanism that needs a deploy to disable is not one.
 *
 * 2. One at a time. A Postgres advisory lock, so two containers coming up together cannot
 *    both migrate. Without it, replicas race on the same ALTER and one of them fails.
 *
 * 3. Failure stops the deploy, not the site. A non-zero exit means the container never
 *    starts, the deploy goes red, and the container already serving keeps serving. The
 *    alternative — starting anyway on a half-applied schema — is exactly the silent drift
 *    this exists to prevent.
 *
 * 4. It waits rather than skips. If another container holds the lock it is migrating, and
 *    starting before it finishes would serve requests against the old schema; so this
 *    waits for it, and only gives up after long enough that something is clearly wrong.
 */

/**
 * A fixed key, arbitrary but constant: two containers must derive the same number or the
 * lock protects nothing.
 */
const LOCK_KEY = 8_421_337;

/** Long enough for the longest migration run seen, short enough not to hang a deploy. */
const LOCK_WAIT_MS = 5 * 60_000;
const LOCK_POLL_MS = 2_000;

const selfPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(selfPath);
// ".js" in the built image, ".ts" under tsx in development — invoked the same way this was.
const extension = path.extname(selfPath);

function runMigrations(): Promise<number> {
  const target = path.join(scriptDir, `applyAllMigrations${extension}`);
  const args = extension === ".ts" ? ["--import", "tsx", target] : [target];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (error) => {
      console.error("[migrateOnStart] could not start the migration runner:", error);
      resolve(1);
    });
  });
}

async function run(): Promise<void> {
  if ((process.env.RUN_MIGRATIONS_ON_START ?? "").trim().toLowerCase() !== "true") {
    console.log(
      "[migrateOnStart] RUN_MIGRATIONS_ON_START is not 'true' — starting without migrating.",
    );
    return;
  }

  const client = await pool.connect();
  let holdsLock = false;
  try {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [LOCK_KEY],
      );
      holdsLock = result.rows[0]?.locked === true;
      if (holdsLock) break;

      if (Date.now() >= deadline) {
        // Five minutes is far longer than a migration run takes. Something is holding the
        // lock that should not be — a container killed mid-migration, most likely. Starting
        // is the lesser risk: the schema is whatever the last successful run left, which is
        // the same position as before this script existed.
        console.error(
          "[migrateOnStart] another container has held the migration lock for five minutes. " +
            "Starting anyway — check whether a deploy died part-way through.",
        );
        return;
      }
      console.log("[migrateOnStart] another container is migrating; waiting…");
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }

    console.log("[migrateOnStart] applying migrations…");
    const exitCode = await runMigrations();
    if (exitCode !== 0) {
      // Deliberately fatal. The container will not start, the deploy fails, and whatever is
      // already serving carries on serving — which is what should happen when the schema a
      // build needs could not be put in place.
      console.error(
        `[migrateOnStart] MIGRATIONS FAILED (exit ${exitCode}). The API will not start.\n` +
          `The previous container keeps serving. Fix the migration and deploy again, or set\n` +
          `RUN_MIGRATIONS_ON_START=false to start without migrating.`,
      );
      process.exitCode = exitCode;
      return;
    }
    console.log("[migrateOnStart] migrations applied. Starting the API.");
  } catch (error) {
    console.error("[migrateOnStart] failed:", error);
    process.exitCode = 1;
  } finally {
    if (holdsLock) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
      } catch {
        // Session-scoped: releasing the connection drops it anyway.
      }
    }
    client.release();
  }
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabasePool();
  });
