import { createApp } from "./app.js";
import { closeDatabasePool } from "./config/database.js";
import { env } from "./config/env.js";
import { checkDatabaseHealth } from "./services/databaseHealthService.js";
import { verifyRuntimeSchema } from "./services/runtime/runtimeVerificationService.js";

const app = await createApp();

const server = app.listen(env.PORT, () => {
  console.log(`OpenCall API listening on port ${env.PORT}`);

  void checkDatabaseHealth().then(async (health) => {
    if (health.connected) {
      console.log(
        `Database connected: ${health.databaseName ?? "unknown"} (${health.latencyMs}ms)`,
      );
      const runtime = await verifyRuntimeSchema().catch((error: unknown) => ({
        ok: false,
        checkedAt: new Date().toISOString(),
        missingTables: [],
        missingColumns: [],
        missingFeatureTables: [],
        degraded: false,
        error: error instanceof Error ? error.message : "Unknown runtime verification error",
      }));

      if (runtime.ok) {
        // A feature table is missing: the API serves, but the endpoints backed by
        // that migration will 500 until it is applied. Loud on purpose — this is
        // the signal that was missing when an unapplied migration took a page down.
        if (runtime.degraded) {
          console.error(
            "Runtime verification degraded: unapplied migration(s). These tables are missing",
            { missingFeatureTables: runtime.missingFeatureTables },
          );
          return;
        }

        console.log("Runtime verification passed");
        return;
      }

      console.error("Runtime verification failed", {
        missingTables: runtime.missingTables,
        missingColumns: runtime.missingColumns,
      });
      return;
    }

    console.error(`Database disconnected: ${health.error ?? "unknown error"}`);
  });
});

let isShuttingDown = false;
const SHUTDOWN_GRACE_MS = 110_000;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}; draining API server`);

  const forceExitTimer = setTimeout(() => {
    console.error("Graceful shutdown timed out; forcing exit");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExitTimer.unref();

  server.close(async (error) => {
    if (error) {
      console.error("Failed to close HTTP server", error);
      process.exitCode = 1;
    }

    await closeDatabasePool().catch((poolError: unknown) => {
      console.error("Failed to close database pool", poolError);
      process.exitCode = 1;
    });

    clearTimeout(forceExitTimer);
    process.exit();
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
