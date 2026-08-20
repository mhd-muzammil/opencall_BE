import "dotenv/config";
import { closeDatabasePool } from "../config/database.js";
import { pollAllMailboxes } from "../services/inboundEmail/inboundEmailService.js";

/**
 * Customer email ingest worker — Stage 1: READ ONLY.
 *
 * Polls every registered region mailbox on an interval and stores new messages with their
 * best match to a call. It NEVER sends mail; there is no SMTP path in this stage.
 *
 * Runs as its own process (like the warranty and FieldEZ workers) so a mailbox outage, a
 * hung IMAP socket or a crash here can never take the API down.
 *
 *   pnpm mail:worker
 *
 * Interval: MAIL_POLL_MINUTES (default 3).
 */

function minutes(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const POLL_MINUTES = minutes("MAIL_POLL_MINUTES", 3);

function stamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

let running = false;

async function sweep(): Promise<void> {
  // A slow mailbox must not let two sweeps overlap and double-fetch.
  if (running) {
    console.log(`[mailWorker ${stamp()}] previous sweep still running — skipped`);
    return;
  }
  running = true;
  try {
    const results = await pollAllMailboxes();
    if (results.length === 0) {
      console.log(`[mailWorker ${stamp()}] no mailboxes configured (set MAIL_* in .env)`);
      return;
    }
    for (const r of results) {
      console.log(
        `[mailWorker ${stamp()}] ${r.mailbox} — since-watermark ${r.fetched}, pending ${r.pending}, stored ${r.stored}, matched ${r.matched}` +
          (r.error ? ` — ERROR: ${r.error}` : ""),
      );
    }
  } catch (error) {
    console.error(`[mailWorker ${stamp()}] sweep failed:`, error);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  console.log(
    `[mailWorker ${stamp()}] starting — read-only ingest, polling every ${POLL_MINUTES} min. No mail is ever sent.`,
  );
  await sweep();
  const timer = setInterval(() => void sweep(), POLL_MINUTES * 60_000);

  const shutdown = async (signal: string) => {
    console.log(`[mailWorker ${stamp()}] ${signal} — shutting down`);
    clearInterval(timer);
    await closeDatabasePool();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
