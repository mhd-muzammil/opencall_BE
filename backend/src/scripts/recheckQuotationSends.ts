import "dotenv/config";
import { closeDatabasePool, query } from "../config/database.js";

/**
 * Ask the Sent folders again, now, instead of waiting a day.
 *
 * The verifier writes `sent_checked_at` whether it found the mail or not, and that stamp is
 * what stops the same fruitless search running every three minutes for ever. It also means a
 * quotation already asked about is not asked again for a day — which is right while the
 * verifier's answer is trustworthy, and exactly wrong the moment the verifier improves.
 *
 * It has just improved: it now reads every Sent folder in a mailbox rather than the first one
 * it finds, and asks about the customer's address before the work order. Forty quotations
 * carry a "not found" that was reached without looking in half the folders, and left alone
 * they would keep it until tomorrow.
 *
 * So this clears the stamp and nothing else. The next sweep treats them as never asked and
 * works through them a handful at a time, exactly as it did the first time.
 *
 * NARROW ON PURPOSE. Only quotations that carry no send and are still open — a quotation
 * already known to have gone out keeps its date, and a settled one is not touched at all.
 * `sent_at`, `payment_status`, `reply_seen_at` and every other column are left completely
 * alone: this makes a question be asked again, it does not answer it.
 *
 * Safe to run twice. The second run clears a stamp that is already clear.
 *
 *   node dist/scripts/recheckQuotationSends.js
 */

async function run(): Promise<void> {
  const before = await query<{ waiting: string; asked: string }>(
    `SELECT COUNT(*)::TEXT AS waiting,
            COUNT(*) FILTER (WHERE sent_checked_at IS NOT NULL)::TEXT AS asked
       FROM quotations
      WHERE sent_at IS NULL
        AND payment_status = 'PENDING'`,
  );
  const waiting = Number(before.rows[0]?.waiting ?? 0);
  const asked = Number(before.rows[0]?.asked ?? 0);

  console.log(`${waiting} quotation(s) show Created with no send recorded.`);
  console.log(`${asked} of those have already been asked about and are waiting out the day.`);

  if (asked === 0) {
    console.log("Nothing to clear — every one of them is already queued to be asked.");
    return;
  }

  const result = await query(
    `UPDATE quotations
        SET sent_checked_at = NULL
      WHERE sent_at IS NULL
        AND payment_status = 'PENDING'
        AND sent_checked_at IS NOT NULL`,
  );
  console.log(`\nCleared the stamp on ${result.rowCount} quotation(s).`);
  console.log(
    `They will be asked about again from the next sweep, eight at a time, roughly\n` +
      `${Math.ceil(waiting / 8) * 3} minutes for all ${waiting}. Watch the worker log for:\n\n` +
      `  [sendVerify] RTPL/26-27/QEN/nn was sent — found in <mailbox>/<folder>, <date>\n\n` +
      `Nothing else was changed. No quotation was marked sent, paid or replied by this.`,
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
