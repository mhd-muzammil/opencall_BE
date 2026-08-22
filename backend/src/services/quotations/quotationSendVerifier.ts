import { ImapFlow } from "imapflow";
import {
  listQuotationsNeedingSendCheck,
  recordQuotationSendCheck,
  type QuotationSendCheck,
} from "../../repositories/quotationWatchRepository.js";
import { listActiveMailboxes } from "../../repositories/inboundEmailRepository.js";
import { mailboxPassword } from "../inboundEmail/mailboxCredentials.js";
import { resolveSentFolder } from "../inboundEmail/sentFolderArchiver.js";

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
 * searching it for a quotation's work order or its customer's address answers the question
 * with evidence rather than an assumption. Found means sent, and the mail's own date is the
 * send date. Not found means not mailed from here — WhatsApp, the counter, a phone call —
 * and Created is the truthful answer.
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

export interface SendVerifyResult {
  checked: number;
  foundSent: number;
}

/** The mail that carried a quotation out, if the Sent folder has one. */
async function findSentMail(
  client: ImapFlow,
  quotation: QuotationSendCheck,
): Promise<{ date: Date; to: string } | null> {
  // The work order first: it is in the subject of anything about this job, and it is
  // specific in a way an address is not — a customer with three jobs has three quotations
  // and one address.
  const searches: Array<Record<string, unknown>> = [];
  if (quotation.orderNumber) {
    searches.push({ since: new Date(quotation.raisedAt), text: quotation.orderNumber });
  }
  if (quotation.customerEmail) {
    searches.push({ since: new Date(quotation.raisedAt), to: quotation.customerEmail });
  }

  for (const criteria of searches) {
    let uids: unknown;
    try {
      uids = await client.search(criteria, { uid: true });
    } catch {
      // One search failing is not worth ending the check for; the next criterion may work.
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
      const folder = await resolveSentFolder(client);
      if (!folder) {
        console.error(`[sendVerify] no Sent folder on ${mailbox.email}`);
        continue;
      }
      const lock = await client.getMailboxLock(folder);
      try {
        for (const quotation of pending) {
          if (settled.has(quotation.id)) continue;
          const found = await findSentMail(client, quotation);
          if (!found) continue;

          await recordQuotationSendCheck({
            id: quotation.id,
            sentAt: found.date.toISOString(),
            sentTo: found.to,
          });
          settled.add(quotation.id);
          result.foundSent += 1;
          console.log(
            `[sendVerify] ${quotation.quotationNo} was sent — found in ${mailbox.email}'s Sent folder, ${found.date.toISOString().slice(0, 10)}`,
          );
        }
      } finally {
        lock.release();
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
