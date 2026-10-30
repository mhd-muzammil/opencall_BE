import { ImapFlow } from "imapflow";
import {
  listQuotationsNeedingSendCheck,
  recordQuotationSendCheck,
  type QuotationSendCheck,
} from "../../repositories/quotationWatchRepository.js";
import { listActiveMailboxes } from "../../repositories/inboundEmailRepository.js";
import { mailboxPassword } from "../inboundEmail/mailboxCredentials.js";
import { listSentFolders } from "../inboundEmail/sentFolderScanner.js";
import { quotationOfMessageId } from "./quotationMessageId.js";

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
 * THE CUSTOMER'S ADDRESS IS THE ONLY QUESTION. Every quotation is mailed and every one
 * records where it was mailed to, so "did anything go to this customer" is answerable for
 * all of them. The work order was asked as well and earned nothing: it is findable only when
 * someone typed it into the subject — inside the attached PDF no text search reaches it — and
 * when it did match, it matched any mail quoting that job rather than the quotation leaving.
 * One question, asked of the one field that is always filled in.
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

/** How far a mail's own Date may sit before the quotation was raised: clock drift, no more. */
const CREATED_SLACK_MS = 5 * 60_000;

/** A quotation number as OpenCall writes it, Part (QEN) or Visit (QEV). */
const QUOTATION_NO = /RTPL\/\d{2}-\d{2}\/QE[NV]\/\d+/gi;

export interface SendVerifyResult {
  checked: number;
  foundSent: number;
}

/** A mail in a Sent folder that went to the quotation's customer. */
export interface SentMailCandidate {
  uid: number;
  date: Date | null;
  to: string;
  subject: string;
  /** The mail's Message-ID, which names the quotation when the mail was sent from here. */
  messageId?: string;
}

/**
 * Which of the mails to this customer carried THIS quotation: the earliest one that was sent
 * after the quotation was raised and does not name a different quotation.
 *
 * Both tests matter now that a customer commonly has two quotations a few hours or days apart
 * — the Visit quotation, then the Part quotation on the same job. Matched by address alone,
 * the Visit's mail reads as the Part going out: the Part shows Sent before it existed, and the
 * reply watcher then counts the Visit's "payment done" as an answer to it. A mail whose subject
 * carries no quotation number (one sent from webmail by hand) still counts.
 *
 * A mail sent from here names its quotation in its Message-ID, and that is asked first: the
 * Visit mail's subject names no quotation, so without it a Visit sent or re-sent after the
 * Part was raised would read as the Part going out.
 */
export function pickSentMail(
  candidates: readonly SentMailCandidate[],
  quotation: Pick<QuotationSendCheck, "quotationNo" | "createdAt"> & { id?: string },
): { date: Date; to: string } | null {
  const notBefore = new Date(quotation.createdAt).getTime() - CREATED_SLACK_MS;
  const own = quotation.quotationNo.toUpperCase();
  const ownId = (quotation.id ?? "").toLowerCase();
  for (const mail of [...candidates].sort((a, b) => a.uid - b.uid)) {
    if (!mail.date || mail.date.getTime() < notBefore) continue;
    const owner = quotationOfMessageId(mail.messageId);
    if (owner && owner !== ownId) continue;
    const named = (mail.subject.match(QUOTATION_NO) ?? []).map((n) => n.toUpperCase());
    if (named.length > 0 && !named.includes(own)) continue;
    return { date: mail.date, to: mail.to };
  }
  return null;
}

/** The mail that carried a quotation out, if this Sent folder has one. */
async function findSentMail(
  client: ImapFlow,
  quotation: QuotationSendCheck,
  onSearchError: (detail: string) => void,
): Promise<{ date: Date; to: string } | null> {
  if (!quotation.customerEmail) return null;
  const since = new Date(new Date(quotation.raisedAt).getTime() - CLOCK_SLACK_DAYS * 86_400_000);

  // THE CUSTOMER'S ADDRESS, AND NOTHING ELSE. Every quotation is mailed and every one
  // records the address it is mailed to, so this one question is answerable for all of them.
  //
  // Searching the work order as well was strictly worse in both directions. It found nothing
  // extra when the reference lives only inside the attached PDF, which is where it usually
  // lives — and when it did hit, it hit any mail quoting that job, which is not the same
  // thing as the quotation going out. A second criterion that adds no true answers and can
  // add false ones is not a fallback, it is a way to be wrong.
  const label = `to ${quotation.customerEmail}`;
  let uids: unknown;
  try {
    uids = await client.search({ since, to: quotation.customerEmail }, { uid: true });
  } catch (error) {
    // Reported, not swallowed. A server rejecting the search used to read as a clean "not
    // found", which is what a reader also sees when the mail genuinely is not there — and
    // those two need completely different fixes.
    onSearchError(`${label} — ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const list = (Array.isArray(uids) ? uids : []).map(Number).filter((n) => n > 0);
  if (list.length === 0) return null;

  // Every match is read, not only the first: the first mail to this customer may be another
  // quotation's (see pickSentMail). Of the ones that are this quotation's, the EARLIEST — a
  // quotation may have been chased more than once, and what is wanted is when the customer
  // first had it, the same rule the send path follows.
  const candidates: SentMailCandidate[] = [];
  try {
    for await (const message of client.fetch(list, { uid: true, envelope: true }, { uid: true })) {
      candidates.push({
        uid: Number(message.uid),
        date: message.envelope?.date ?? null,
        to: message.envelope?.to?.[0]?.address ?? "",
        subject: message.envelope?.subject ?? "",
        messageId: message.envelope?.messageId ?? "",
      });
    }
  } catch (error) {
    // Found mail to the customer but could not read it, so which quotation it carried is
    // unknown. Asked again after the recheck interval rather than guessed now.
    onSearchError(`${label} — could not read the matches: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  return pickSentMail(candidates, quotation);
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
