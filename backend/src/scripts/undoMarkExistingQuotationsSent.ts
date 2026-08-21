import "dotenv/config";
import { closeDatabasePool, query } from "../config/database.js";

/**
 * Undo the "already sent" stamp, so Sent means what it says again.
 *
 * `markExistingQuotationsSent` recorded that every quotation raised before OpenCall could
 * send had reached its customer — true, but it made Sent mean "the customer has it, by some
 * route", and the funnel underneath it does not survive that reading. Replied and No reply
 * are answers to a mail WE sent; a quotation handed over at the counter has no such mail to
 * be replied to, and counting it under Sent leaves those two boxes describing something
 * that never happened.
 *
 * So Sent goes back to meaning mailed from here. Created carries the rest, which is the
 * honest place for them: nothing was sent, so nothing is awaited.
 *
 * They do not become invisible. A customer who wrote about one still shows on the row as
 * "Created · check payment" with a link to the message, because the watcher reads their
 * work order's mail whether the quotation was sent from here or not.
 *
 * ONLY the rows this stamped, matched on the `sent_by` marker it wrote. A quotation
 * genuinely mailed from OpenCall carries a real sender and is left completely alone —
 * which is also what makes this safe to run twice.
 *
 *   node dist/scripts/undoMarkExistingQuotationsSent.js
 */

const MARKER = "sent outside OpenCall";

async function run(): Promise<void> {
  const before = await query<{ stamped: string }>(
    `SELECT COUNT(*)::TEXT AS stamped FROM quotations WHERE sent_by = $1`,
    [MARKER],
  );
  const stamped = Number(before.rows[0]?.stamped ?? 0);
  console.log(`${stamped} quotation(s) carry the "already sent" stamp.`);
  if (stamped === 0) {
    console.log("Nothing to undo — no quotation was stamped by that script.");
    return;
  }

  const result = await query(
    `UPDATE quotations
        SET sent_at = NULL,
            last_sent_at = NULL,
            send_count = 0,
            sent_to = '',
            sent_by = NULL
      WHERE sent_by = $1`,
    [MARKER],
  );
  console.log(`Undone on ${result.rowCount} quotation(s).`);

  const after = await query<{
    created: string;
    sent: string;
    replied: string;
    no_reply: string;
    paid: string;
    rejected: string;
  }>(
    `SELECT COUNT(*) FILTER (WHERE sent_at IS NULL AND payment_status = 'PENDING')::TEXT AS created,
            COUNT(*) FILTER (WHERE sent_at IS NOT NULL AND payment_status = 'PENDING')::TEXT AS sent,
            COUNT(*) FILTER (WHERE sent_at IS NOT NULL AND reply_seen_at IS NOT NULL AND payment_status = 'PENDING')::TEXT AS replied,
            COUNT(*) FILTER (WHERE sent_at IS NOT NULL AND reply_seen_at IS NULL AND payment_status = 'PENDING')::TEXT AS no_reply,
            COUNT(*) FILTER (WHERE payment_status = 'PAID')::TEXT AS paid,
            COUNT(*) FILTER (WHERE payment_status = 'DECLINED')::TEXT AS rejected
       FROM quotations`,
  );
  const row = after.rows[0]!;
  console.log(
    `\nThe header will now read:\n` +
      `  Created ${row.created} · Sent ${row.sent} · Replied ${row.replied} · ` +
      `No reply ${row.no_reply} · Paid ${row.paid} · Rejected ${row.rejected}\n\n` +
      `Quotations a customer has written about still show "Created · check payment" on\n` +
      `their row, with a link to the message — the watcher reads their work order's mail\n` +
      `whether or not the quotation was sent from here.`,
  );
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabasePool();
  });
