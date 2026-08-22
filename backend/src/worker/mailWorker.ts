import "dotenv/config";
import { closeDatabasePool } from "../config/database.js";
import { pollAllMailboxes } from "../services/inboundEmail/inboundEmailService.js";
import { runQuotationPaymentWatch } from "../services/quotations/quotationPaymentWatch.js";
import { runQuotationSendVerification } from "../services/quotations/quotationSendVerifier.js";

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
    // Reported per mailbox as each one lands, not collected and printed at the end: a
    // sweep working through a backlog takes minutes, and a silent log for the whole of it
    // reads exactly like a hung worker.
    const results = await pollAllMailboxes(
      (r) => {
        console.log(
          `[mailWorker ${stamp()}] ${r.mailbox} — since-watermark ${r.fetched}, pending ${r.pending}, stored ${r.stored}, matched ${r.matched}` +
            (r.error ? ` — ERROR: ${r.error}` : ""),
        );
      },
      // Printed before the step runs, so the last line in the log names whatever the worker
      // is currently inside. Silence after a step line is where it stopped.
      (step) => console.log(`[mailWorker ${stamp()}] ... ${step}`),
    );
    if (results.length === 0) {
      console.log(`[mailWorker ${stamp()}] no mailboxes configured (set MAIL_* in .env)`);
      return;
    }
    // A few of the quotations that carry no send, asked of the mailbox's own Sent folder.
    // Before the payment watch, because it can turn one into a sent quotation and the watch
    // reads that. Its own try/catch: a mailbox that will not open must not stop the reply
    // reading, which needs no mailbox at all.
    try {
      const verified = await runQuotationSendVerification();
      if (verified.checked > 0) {
        console.log(
          `[mailWorker ${stamp()}] quotation sends — checked ${verified.checked}, ` +
            `${verified.foundSent} found in a Sent folder`,
        );
      }
    } catch (error) {
      console.error(`[mailWorker ${stamp()}] send verification failed:`, error);
    }

    // Straight after the sweep, on the mail it has just stored: a customer who answers a
    // quotation should show as having answered without anyone opening the inbox. Wrapped
    // separately because this is downstream of the ingest — if it fails, the mail is still
    // in and the next sweep tries again, and it must not make the sweep look failed.
    try {
      const watch = await runQuotationPaymentWatch();
      if (watch.repliedNow > 0 || watch.autoPaid > 0 || watch.needsLook > 0) {
        console.log(
          `[mailWorker ${stamp()}] quotations — ${watch.repliedNow} newly replied, ` +
            `${watch.autoPaid} auto-marked paid, ${watch.needsLook} need a look, ${watch.unflagged} un-flagged, ` +
            `${watch.screenshotsRead} screenshot(s) read (of ${watch.checked} awaiting)`,
        );
      }
    } catch (error) {
      console.error(`[mailWorker ${stamp()}] quotation watch failed:`, error);
    }

    // The backlog across every mailbox, so one line answers "is this catching up?".
    const stillPending = results.reduce((total, r) => total + Math.max(0, r.pending - r.stored), 0);
    console.log(
      `[mailWorker ${stamp()}] sweep done — stored ${results.reduce((t, r) => t + r.stored, 0)}, ` +
        `${stillPending === 0 ? "up to date" : `${stillPending} still to fetch`}`,
    );
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
