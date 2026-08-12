import { closeDatabasePool, pool } from "../config/database.js";
import { toFullText, toPreview } from "../services/inboundEmail/emailMatcher.js";

// One-off repair for messages ingested before the body cleaner understood base64.
//
// HP's Outlook sends base64 with no per-part MIME headers, so `extractReadableBody` left
// the blob untouched and the reading pane showed "UmVtaW5kZXIuDQoNCg0K..." instead of the
// customer's words. The stored `body_text` IS that raw blob, so re-running the (now fixed)
// cleaner over it recovers the message — no re-fetch from IMAP, no watermark movement, and
// nothing sent.
//
//   node dist/scripts/backfillInboundEmailBodies.js     (production)
//   pnpm --filter @opencall/api backfill:email-bodies   (development)
//
// Idempotent: prose passes through the cleaner unchanged, so a row that is already correct
// produces an identical result and is skipped. Safe to run more than once.

interface Row {
  id: string;
  body_text: string;
}

async function run(): Promise<void> {
  const client = await pool.connect();
  let scanned = 0;
  let repaired = 0;
  try {
    const { rows } = await client.query<Row>(
      `SELECT id::TEXT, body_text FROM inbound_emails
        WHERE body_text <> ''
        ORDER BY received_at DESC`,
    );

    for (const row of rows) {
      scanned += 1;
      const fullText = toFullText(row.body_text);
      // Unchanged means the row was never base64 — leave it exactly as it is.
      if (fullText === row.body_text) continue;

      await client.query(
        `UPDATE inbound_emails SET body_text = $2, body_preview = $3 WHERE id = $1`,
        [row.id, fullText, toPreview(row.body_text)],
      );
      repaired += 1;
    }

    console.log(`Backfill complete: ${scanned} scanned, ${repaired} repaired.`);
  } catch (error) {
    console.error("Backfill failed:", error);
    throw error;
  } finally {
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
