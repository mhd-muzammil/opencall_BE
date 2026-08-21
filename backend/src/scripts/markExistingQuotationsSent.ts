import "dotenv/config";
import { closeDatabasePool, query } from "../config/database.js";

/**
 * Record that the quotations already in the system reached their customers.
 *
 * Sending through OpenCall is new. Every quotation raised before it was mailed from
 * webmail, sent on WhatsApp, or handed over at the counter — so `sent_at` is null on all of
 * them, and the header counts them as never sent when in fact every one went out. The
 * funnel reads Created 47 / Sent 0, which is the opposite of what happened.
 *
 * This stamps the send that did happen. `sent_at` becomes the quotation's own date, which
 * is the nearest honest answer available: nobody recorded the day it was mailed, and the
 * day it was raised is when it was given out. `sent_by` says plainly that it did not go
 * through here, so nobody later reads it as a send this system made.
 *
 * ONLY rows with no send recorded. A quotation mailed from OpenCall has a real timestamp
 * and a real sender, and neither is worth overwriting with an approximation — which also
 * makes this safe to run twice.
 *
 * Nothing else is touched: not the quotation number, not the figures, not the customer,
 * not the payment status.
 *
 *   node dist/scripts/markExistingQuotationsSent.js
 */

async function run(): Promise<void> {
  const before = await query<{ total: string; unsent: string }>(
    `SELECT COUNT(*)::TEXT AS total,
            COUNT(*) FILTER (WHERE sent_at IS NULL)::TEXT AS unsent
       FROM quotations`,
  );
  const total = Number(before.rows[0]?.total ?? 0);
  const unsent = Number(before.rows[0]?.unsent ?? 0);

  console.log(`${total} quotation(s) in all, ${unsent} with no send recorded.`);
  if (unsent === 0) {
    console.log("Nothing to do — every quotation already carries a send.");
    return;
  }

  const result = await query<{ quotation_no: string }>(
    `UPDATE quotations
        SET sent_at = quotation_date::timestamptz,
            last_sent_at = quotation_date::timestamptz,
            send_count = GREATEST(send_count, 1),
            sent_to = COALESCE(NULLIF(sent_to, ''), customer_email, ''),
            sent_by = 'sent outside OpenCall'
      WHERE sent_at IS NULL
      RETURNING quotation_no`,
  );

  console.log(`\nMarked ${result.rowCount} quotation(s) as already sent:`);
  for (const row of result.rows.slice(0, 10)) {
    console.log(`  ${row.quotation_no}`);
  }
  if (result.rows.length > 10) {
    console.log(`  … and ${result.rows.length - 10} more`);
  }

  const after = await query<{
    created: string;
    sent: string;
    replied: string;
    no_reply: string;
    paid: string;
  }>(
    `SELECT COUNT(*) FILTER (WHERE sent_at IS NULL)::TEXT AS created,
            COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::TEXT AS sent,
            COUNT(*) FILTER (WHERE sent_at IS NOT NULL AND reply_seen_at IS NOT NULL)::TEXT AS replied,
            COUNT(*) FILTER (WHERE sent_at IS NOT NULL AND reply_seen_at IS NULL)::TEXT AS no_reply,
            COUNT(*) FILTER (WHERE payment_status = 'PAID')::TEXT AS paid
       FROM quotations`,
  );
  const row = after.rows[0]!;
  console.log(
    `\nThe header will now read:\n` +
      `  Created ${row.created} · Sent ${row.sent} · Replied ${row.replied} · ` +
      `No reply ${row.no_reply} · Paid ${row.paid}`,
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
