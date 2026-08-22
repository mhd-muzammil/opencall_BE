import { ImapFlow } from "imapflow";
import {
  listQuotationsNeedingSendCheck,
  recordQuotationSendCheck,
  type QuotationSendCheck,
} from "../../repositories/quotationWatchRepository.js";
import { listActiveMailboxes } from "../../repositories/inboundEmailRepository.js";
import { mailboxPassword } from "../inboundEmail/mailboxCredentials.js";
import { listSentFolders } from "../inboundEmail/sentFolderScanner.js";

/**
 * Ask the mailbox whether a quotation was ever actually sent.
 *
 * Quotations raised before OpenCall could send carry no send date, and guessing is the one
 * thing that must not happen here: stamping them all as sent made Sent mean "the customer
 * has this somehow", and Replied and No reply — which are answers to a mail WE sent —
 * became answers to nothing. Leaving them all as Created is equally wrong, since plenty
 * were mailed from webmail.
 *
 * The mailbox knows. Webmail files what it sends in the same Sent folder OpenCall does, so
 * searching it for the address a quotation went to answers the question with evidence rather
 * than an assumption. Found means sent, and the mail's own date is the send date. Not found
 * means the mail is not in any folder this can reach, and Created is the truthful answer.
 *
 * THE CUSTOMER'S ADDRESS IS THE QUESTION. Every quotation is mailed and every one records
 * where it was mailed to, so "did anything go to this customer" is answerable for all of
 * them. The work order is more specific and stays as a second ask, but it only helps when
 * someone typed it into the subject — inside the attached PDF it is beyond any text search.
 *
 * EVERY SENT FOLDER, not the first one found. A mailbox used from webmail and from Outlook
 * has two: the one the server flags \Sent, and the one Outlook made for itself. Reading only
 * the flagged one leaves everything sent from the other reading as never sent.
 *
 * A FEW AT A TIME. Every check is an IMAP search per mailbox, so a sweep takes a handful
 * and leaves the rest; `sent_checked_at` remembers where it got to. A hundred quotations
 * settle over an hour rather than the mail server being searched to death every three
 * minutes for ever. Nothing has to be run by hand.
 */

/** Per sweep. Small enough to be unnoticeable, large enough to clear a backlog in an hour. */
const PER_SWEEP = Number(process.env.QUOTATION_SEND_CHECK_BATCH ?? 8) || 8;

/**
 * How long before a "not found" is asked again.
 *
 * Not never: a quotation raised this morning may be mailed this afternoon, and the answer
 * changes. Not often either — a day is soon enough for something nobody is waiting on.
 */
const RECHECK_AFTER_HOURS = Number(process.env.QUOTATION_SEND_RECHECK_HOURS ?? 24) || 24;

/**
 * How far before the quotation's own date the search reaches back.
 *
 * `quotation_date` is a DATE — midnight — and the mail server files by its own clock in its
 * own zone, so a quotation raised on the 19th and mailed at nine that morning can carry an
 * INTERNALDATE of the 18th once the offsets are applied. A search starting exactly at
 * midnight loses that mail to arithmetic rather than to anything real.
 *
 * One day, and no more. The bound is what stops last month's correspondence with the same
 * customer being read as this quotation going out, so it is widened by the smallest amount
 * that covers a timezone and not by an amount that covers a different job.
 */
const CLOCK_SLACK_DAYS = 1;

export interface SendVerifyResult {
  checked: number;
  foundSent: number;
}

/** The mail that carried a quotation out, if this Sent folder has one. */
async function findSentMail(
  client: ImapFlow,
  quotation: QuotationSendCheck,
  onSearchError: (detail: string) => void,
): Promise<{ date: Date; to: string } | null> {
  const since = new Date(new Date(quotation.raisedAt).getTime() - CLOCK_SLACK_DAYS * 86_400_000);

  // THE CUSTOMER'S ADDRESS FIRST. Every quotation goes out by mail and every one carries the
  // address it goes to, so "was anything sent to this customer" is the question that is
  // actually answerable for all of them. The work order is the more specific reference and
  // stays as the second ask, but it is only in the subject if whoever typed it put it there —
  // and when it lives only inside the attached PDF, no text search reaches it.
  const searches: Array<[string, Record<string, unknown>]> = [];
  if (quotation.customerEmail) {
    searches.push([`to ${quotation.customerEmail}`, { since, to: quotation.customerEmail }]);
  }
  if (quotation.orderNumber) {
    searches.push([`text ${quotation.orderNumber}`, { since, text: quotation.orderNumber }]);
  }

  for (const [label, criteria] of searches) {
    let uids: unknown;
    try {
      uids = await client.search(criteria, { uid: true });
    } catch (error) {
      // Reported, not swallowed. A server rejecting a criterion used to read as a clean
      // "not found", which is the same thing a reader sees when the mail genuinely is not
      // there — and those two need completely different fixes.
      onSearchError(`${label} — ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const list = (Array.isArray(uids) ? uids : []).map(Number).filter((n) => n > 0);
    if (list.length === 0) continue;

    // The EARLIEST match. A quotation may have been chased more than once, and what is
    // wanted is when the customer first had it — the same rule the send path follows.
    const first = Math.min(...list);
    try {
      for await (const message of client.fetch([first], { uid: true, envelope: true }, { uid: true })) {
        const date = message.envelope?.date;
        const to = message.envelope?.to?.[0]?.address ?? "";
        if (date) return { date, to };
      }
    } catch {
      // Found it but could not read it. Knowing it exists is enough to say it was sent;
      // the date is the only thing lost, and the quotation's own date stands in.
      return { date: new Date(quotation.raisedAt), to: quotation.customerEmail };
    }
  }
  return null;
}

export async function runQuotationSendVerification(): Promise<SendVerifyResult> {
  const result: SendVerifyResult = { checked: 0, foundSent: 0 };

  const pending = await listQuotationsNeedingSendCheck({
    limit: PER_SWEEP,
    recheckAfterHours: RECHECK_AFTER_HOURS,
  });
  if (pending.length === 0) return result;

  const host = process.env.MAIL_IMAP_HOST ?? "";
  const port = Number(process.env.MAIL_IMAP_PORT ?? 993);
  if (!host) return result;

  const mailboxes = await listActiveMailboxes();
  // Answered by any mailbox, so the rest are not searched for it. A quotation went out
  // once, from one address.
  const settled = new Set<string>();

  for (const mailbox of mailboxes) {
    if (settled.size === pending.length) break;
    const pass = mailboxPassword(mailbox.email);
    if (!pass) continue;

    const client = new ImapFlow({
      host,
      port,
      secure: true,
      auth: { user: mailbox.email, pass },
      logger: false,
      tls: { rejectUnauthorized: false },
      socketTimeout: 5 * 60_000,
    });
    // An 'error' with no listener is fatal to the process — the same rule as everywhere
    // else an ImapFlow client is created.
    client.on("error", (error: unknown) => {
      console.error(
        `[sendVerify] IMAP error on ${mailbox.email}:`,
        error instanceof Error ? error.message : error,
      );
    });

    try {
      await client.connect();
      // EVERY Sent folder, not the first one found. Webmail files into the folder the server
      // flags as \Sent and Outlook makes its own alongside it, so a mailbox used from both
      // has half its history somewhere a single-folder reader never opens — and a quotation
      // mailed from the other one reads as never sent.
      const folders = await listSentFolders(client);
      if (folders.length === 0) {
        console.error(`[sendVerify] no Sent folder on ${mailbox.email}`);
        continue;
      }
      for (const folder of folders) {
        if (settled.size === pending.length) break;
        let lock;
        try {
          lock = await client.getMailboxLock(folder);
        } catch (error) {
          // One unopenable folder is not a reason to give up on the mailbox; the next one
          // may hold everything.
          console.error(
            `[sendVerify] could not open ${mailbox.email}/${folder}:`,
            error instanceof Error ? error.message : error,
          );
          continue;
        }
        try {
          for (const quotation of pending) {
            if (settled.has(quotation.id)) continue;
            const found = await findSentMail(client, quotation, (detail) =>
              console.error(`[sendVerify] search failed in ${mailbox.email}/${folder} — ${detail}`),
            );
            if (!found) continue;

            await recordQuotationSendCheck({
              id: quotation.id,
              sentAt: found.date.toISOString(),
              sentTo: found.to,
            });
            settled.add(quotation.id);
            result.foundSent += 1;
            console.log(
              `[sendVerify] ${quotation.quotationNo} was sent — found in ${mailbox.email}/${folder}, ${found.date.toISOString().slice(0, 10)}`,
            );
          }
        } finally {
          lock.release();
        }
      }
    } catch (error) {
      console.error(
        `[sendVerify] ${mailbox.email} failed:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      try {
        await client.logout();
      } catch {
        /* already closed */
      }
    }
  }

  // Asked and not found. Written down so the same question is not asked again on the next
  // sweep — that is what turns this from a permanent load into a backlog that clears.
  for (const quotation of pending) {
    if (settled.has(quotation.id)) continue;
    try {
      await recordQuotationSendCheck({ id: quotation.id, sentAt: null, sentTo: "" });
    } catch (error) {
      console.error(`[sendVerify] could not record the check on ${quotation.quotationNo}:`, error);
    }
  }

  result.checked = pending.length;
  return result;
}
