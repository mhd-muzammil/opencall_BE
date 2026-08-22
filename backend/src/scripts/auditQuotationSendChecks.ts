import "dotenv/config";
import { ImapFlow } from "imapflow";
import { closeDatabasePool, query } from "../config/database.js";
import { listActiveMailboxes } from "../repositories/inboundEmailRepository.js";
import { mailboxPassword } from "../services/inboundEmail/mailboxCredentials.js";
import { pickSentFolder } from "../services/inboundEmail/sentFolderArchiver.js";

/**
 * Why is a quotation still sitting in Created? Read every Sent folder and print the answer.
 *
 * Every quotation goes to the customer by mail — never WhatsApp, never over the counter —
 * so a quotation the sweep's verifier cannot find in a Sent folder is not a quotation that
 * was handed over another way. It is the verifier failing to see mail that exists, and the
 * only question worth answering is which of its assumptions is wrong:
 *
 *   - The FOLDER. It picks one Sent folder per mailbox. A mailbox with both INBOX.Sent and
 *     INBOX.Sent Items — webmail filing in one, Outlook in the other — has half its history
 *     in a folder nothing ever opens.
 *   - The WINDOW. It searches from the date the quotation carries. Mail sent before that
 *     date is invisible to it, and a quotation typed up days after it went out is exactly
 *     that case.
 *   - The CRITERIA. It searches on the work order and the customer's address. A mail whose
 *     subject carries the quotation number or the case ID instead, with the work order only
 *     inside the attached PDF, matches neither.
 *   - The SEARCH ITSELF. Every search error inside the verifier is swallowed and reads as
 *     "not found", so a server that rejects a criterion looks identical to a clean miss.
 *
 * So this does not use the verifier's search at all. It pulls the ENVELOPE of every message
 * in every Sent-looking folder — recipient, subject, date, nothing heavy — and matches in
 * this process, where the matching can be seen. Then, for the ones it finds that the
 * verifier did not, it re-runs the verifier's own search beside it, which is what separates
 * "the criteria are wrong" from "the search is broken".
 *
 * IT WRITES NOTHING. No quotation is stamped, no watermark moves, no mail is stored. It
 * opens folders, reads envelopes, prints, and logs out. Running it twice is the same as
 * running it once.
 *
 *   node dist/scripts/auditQuotationSendChecks.js
 */

/** Read Sent history from this far before the oldest open quotation. */
const LOOKBACK_DAYS = Number(process.env.AUDIT_LOOKBACK_DAYS ?? 180) || 180;

/** Envelopes per folder. A guard against a folder nobody has ever emptied. */
const MAX_ENVELOPES = Number(process.env.AUDIT_MAX_ENVELOPES ?? 20000) || 20000;

/** Quotations whose miss is re-tested with the verifier's own search, to compare. */
const CROSS_CHECK = 5;

interface Pending {
  quotationNo: string;
  caseId: string;
  orderNumber: string;
  customerEmail: string;
  raisedAt: string;
  sentCheckedAt: string | null;
}

interface SentMail {
  mailbox: string;
  folder: string;
  date: Date;
  subject: string;
  to: string[];
}

interface Match {
  mail: SentMail;
  via: string;
}

function day(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "?" : date.toISOString().slice(0, 10);
}

/**
 * Digits only, for comparing a work order or a case ID against a subject line.
 *
 * WO-035316076 in the database and "WO 035316076" or "#035316076" in a subject are the same
 * reference written three ways, and a literal comparison says they are three different jobs.
 */
function digits(value: string): string {
  return String(value ?? "").replace(/\D+/g, "");
}

/** A folder that looks like it holds sent mail, under any namespace or spelling. */
function isSentLike(path: string, specialUse: string | undefined): boolean {
  if (specialUse === "\\Sent") return true;
  const leaf = path.split(/[./]/).pop() ?? "";
  return /^sent\b/i.test(leaf.trim()) || /^sent$/i.test(leaf.trim());
}

async function headerCounts(): Promise<void> {
  const result = await query<Record<string, string>>(
    `SELECT COUNT(*)::TEXT AS total,
            COUNT(*) FILTER (WHERE sent_at IS NULL AND payment_status = 'PENDING')::TEXT AS created,
            COUNT(*) FILTER (WHERE sent_at IS NOT NULL AND payment_status = 'PENDING')::TEXT AS sent,
            COUNT(*) FILTER (WHERE sent_at IS NOT NULL AND reply_seen_at IS NOT NULL AND payment_status = 'PENDING')::TEXT AS replied,
            COUNT(*) FILTER (WHERE sent_at IS NOT NULL AND reply_seen_at IS NULL AND payment_status = 'PENDING')::TEXT AS no_reply,
            COUNT(*) FILTER (WHERE payment_status = 'PAID')::TEXT AS paid,
            COUNT(*) FILTER (WHERE payment_status = 'DECLINED')::TEXT AS rejected,
            COUNT(*) FILTER (WHERE sent_at IS NULL AND payment_status = 'PENDING' AND sent_checked_at IS NULL)::TEXT AS never_asked,
            COUNT(*) FILTER (WHERE TRIM(COALESCE(customer_email, '')) = '')::TEXT AS no_email
       FROM quotations`,
  );
  const row = result.rows[0]!;
  console.log(`THE SCREEN RIGHT NOW  (${row.total} quotations in total)`);
  console.log(
    `  Created ${row.created} | Sent ${row.sent} | Replied ${row.replied} | ` +
      `No reply ${row.no_reply} | Paid ${row.paid} | Rejected ${row.rejected}`,
  );
  console.log(`  ${row.never_asked} of the Created ones have not been asked about yet`);
  console.log(`  ${row.no_email} quotation(s) in total carry no customer address at all`);
  console.log("");
}

async function listPending(): Promise<Pending[]> {
  const result = await query<{
    quotation_no: string;
    case_id: string;
    order_number: string;
    customer_email: string;
    raised_at: string;
    sent_checked_at: string | null;
  }>(
    `SELECT quotation_no,
            TRIM(COALESCE(case_id, '')) AS case_id,
            TRIM(COALESCE(order_number, '')) AS order_number,
            LOWER(TRIM(COALESCE(customer_email, ''))) AS customer_email,
            quotation_date::timestamptz::TEXT AS raised_at,
            sent_checked_at::TEXT AS sent_checked_at
       FROM quotations
      WHERE sent_at IS NULL
        AND payment_status = 'PENDING'
      ORDER BY quotation_date, quotation_no`,
  );
  return result.rows.map((r) => ({
    quotationNo: r.quotation_no,
    caseId: r.case_id,
    orderNumber: r.order_number,
    customerEmail: r.customer_email,
    raisedAt: r.raised_at,
    sentCheckedAt: r.sent_checked_at,
  }));
}

/** Every message in one open folder, envelope only, from `since` onwards. */
async function readFolder(
  client: ImapFlow,
  mailbox: string,
  folder: string,
  since: Date,
): Promise<SentMail[]> {
  let uids: unknown;
  try {
    uids = await client.search({ since }, { uid: true });
  } catch (error) {
    console.log(`     SEARCH FAILED on ${folder}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  const list = (Array.isArray(uids) ? uids : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b)
    .slice(-MAX_ENVELOPES);
  if (list.length === 0) {
    console.log(`     ${folder}: 0 message(s) since ${day(since)}`);
    return [];
  }

  const mail: SentMail[] = [];
  try {
    for await (const message of client.fetch(list, { uid: true, envelope: true }, { uid: true })) {
      const envelope = message.envelope;
      if (!envelope) continue;
      const recipients = [...(envelope.to ?? []), ...(envelope.cc ?? []), ...(envelope.bcc ?? [])]
        .map((a) => String(a?.address ?? "").trim().toLowerCase())
        .filter(Boolean);
      mail.push({
        mailbox,
        folder,
        date: envelope.date ?? new Date(0),
        subject: String(envelope.subject ?? ""),
        to: recipients,
      });
    }
  } catch (error) {
    console.log(`     FETCH STOPPED on ${folder} after ${mail.length}: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`     ${folder}: ${mail.length} message(s) read since ${day(since)}`);
  return mail;
}

/** The verifier's own search, run beside the audit so the two can be compared. */
async function verifierSearch(
  client: ImapFlow,
  quotation: Pending,
): Promise<string> {
  const tried: string[] = [];
  const criteria: Array<[string, Record<string, unknown>]> = [];
  if (quotation.orderNumber) {
    criteria.push([`text "${quotation.orderNumber}" since ${day(quotation.raisedAt)}`, { since: new Date(quotation.raisedAt), text: quotation.orderNumber }]);
  }
  if (quotation.customerEmail) {
    criteria.push([`to "${quotation.customerEmail}" since ${day(quotation.raisedAt)}`, { since: new Date(quotation.raisedAt), to: quotation.customerEmail }]);
  }
  for (const [label, criterion] of criteria) {
    try {
      const uids = await client.search(criterion, { uid: true });
      const count = Array.isArray(uids) ? uids.length : 0;
      tried.push(`${label} -> ${count} hit(s)`);
    } catch (error) {
      tried.push(`${label} -> SEARCH ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return tried.join("; ");
}

async function run(): Promise<void> {
  console.log("=".repeat(78));
  console.log("QUOTATION SEND AUDIT - read only, nothing is changed");
  console.log("=".repeat(78));
  console.log("");

  await headerCounts();

  const pending = await listPending();
  if (pending.length === 0) {
    console.log("Nothing in Created. There is nothing to audit.");
    return;
  }

  const host = process.env.MAIL_IMAP_HOST ?? "";
  const port = Number(process.env.MAIL_IMAP_PORT ?? 993);
  if (!host) {
    console.log("MAIL_IMAP_HOST is not set on this service, so no mailbox can be opened.");
    return;
  }

  const oldest = pending.reduce(
    (earliest, q) => Math.min(earliest, new Date(q.raisedAt).getTime()),
    Number.POSITIVE_INFINITY,
  );
  const since = new Date(oldest - LOOKBACK_DAYS * 86_400_000);

  const mailboxes = await listActiveMailboxes();
  console.log(`MAILBOXES REGISTERED IN THE DATABASE: ${mailboxes.length}`);
  for (const mailbox of mailboxes) {
    const has = mailboxPassword(mailbox.email) ? "YES" : "NO   <-- cannot be opened";
    console.log(`  ${mailbox.email.padEnd(32)} password on this service: ${has}`);
  }
  console.log("");
  console.log(`Quotations in Created to audit: ${pending.length}`);
  console.log(`Reading Sent history from ${day(since)} onwards`);
  console.log("");
  console.log("=".repeat(78));
  console.log("FOLDERS");
  console.log("=".repeat(78));

  const sent: SentMail[] = [];
  /** Kept open-able for the cross-check pass, keyed by mailbox. */
  const searchable: Array<{ email: string; folder: string }> = [];

  for (const mailbox of mailboxes) {
    const pass = mailboxPassword(mailbox.email);
    if (!pass) {
      console.log(`\n${mailbox.email}: SKIPPED, no password set on this service`);
      continue;
    }
    const client = new ImapFlow({
      host,
      port,
      secure: true,
      auth: { user: mailbox.email, pass },
      logger: false,
      tls: { rejectUnauthorized: false },
      socketTimeout: 15 * 60_000,
    });
    // An 'error' with no listener ends the process. Same rule as everywhere else an
    // ImapFlow client is built.
    client.on("error", (error: unknown) => {
      console.error(`   IMAP error on ${mailbox.email}: ${error instanceof Error ? error.message : String(error)}`);
    });

    try {
      await client.connect();
      const boxes = await client.list();
      const chosen = pickSentFolder(boxes);
      const sentLike = boxes
        .map((b) => ({ path: String(b.path ?? ""), specialUse: b.specialUse }))
        .filter((b) => b.path && isSentLike(b.path, b.specialUse));

      console.log(`\n${mailbox.email}  (${boxes.length} folder(s) total)`);
      console.log(`   the verifier currently opens: ${chosen ?? "NOTHING - no Sent folder matched"}`);
      console.log(`   folders that hold sent mail:  ${sentLike.map((b) => b.path).join(", ") || "none found"}`);
      for (const b of sentLike) {
        if (chosen && b.path !== chosen) {
          console.log(`   >>> ${b.path} is NEVER opened by the verifier`);
        }
      }

      for (const box of sentLike) {
        let lock;
        try {
          lock = await client.getMailboxLock(box.path);
        } catch (error) {
          console.log(`     ${box.path}: COULD NOT OPEN - ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        try {
          sent.push(...(await readFolder(client, mailbox.email, box.path, since)));
          searchable.push({ email: mailbox.email, folder: box.path });
        } finally {
          lock.release();
        }
      }
    } catch (error) {
      console.log(`\n${mailbox.email}: COULD NOT BE OPENED - ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try {
        await client.logout();
      } catch {
        /* already closed */
      }
    }
  }

  console.log("");
  console.log(`Total sent mail read across every mailbox: ${sent.length}`);
  console.log("");
  console.log("=".repeat(78));
  console.log("WHAT THE SENT FOLDERS SAY, QUOTATION BY QUOTATION");
  console.log("=".repeat(78));

  const noTrace: Pending[] = [];
  const onlyBefore: Pending[] = [];
  const missed: Array<{ quotation: Pending; matches: Match[] }> = [];

  for (const quotation of pending) {
    const wo = digits(quotation.orderNumber);
    const caseDigits = digits(quotation.caseId);
    const matches: Match[] = [];
    for (const mail of sent) {
      const reasons: string[] = [];
      if (quotation.customerEmail && mail.to.includes(quotation.customerEmail)) {
        reasons.push("customer address");
      }
      const subjectDigits = digits(mail.subject);
      if (wo.length >= 6 && subjectDigits.includes(wo)) reasons.push("work order in subject");
      if (caseDigits.length >= 6 && subjectDigits.includes(caseDigits)) reasons.push("case id in subject");
      if (mail.subject.toUpperCase().includes(quotation.quotationNo.toUpperCase())) {
        reasons.push("quotation number in subject");
      }
      if (reasons.length > 0) matches.push({ mail, via: reasons.join(" + ") });
    }
    matches.sort((a, b) => a.mail.date.getTime() - b.mail.date.getTime());

    if (matches.length === 0) {
      noTrace.push(quotation);
      continue;
    }

    const raised = new Date(quotation.raisedAt);
    const onOrAfter = matches.filter((m) => m.mail.date.getTime() >= raised.getTime());

    console.log("");
    console.log(
      `${quotation.quotationNo}  raised ${day(quotation.raisedAt)}  ` +
        `${quotation.orderNumber || "(no WO)"}  ${quotation.customerEmail || "(no email)"}`,
    );
    for (const match of matches.slice(0, 5)) {
      const side = match.mail.date.getTime() >= raised.getTime() ? "AFTER " : "BEFORE";
      console.log(
        `    ${day(match.mail.date)} ${side}  ${match.mail.mailbox} / ${match.mail.folder}` +
          `  [${match.via}]  ${match.mail.subject.slice(0, 50)}`,
      );
    }
    if (matches.length > 5) console.log(`    ... and ${matches.length - 5} more`);

    if (onOrAfter.length > 0) {
      missed.push({ quotation, matches: onOrAfter });
      console.log(`    >>> THE MAIL IS THERE, dated on or after the quotation. The verifier missed it.`);
    } else {
      onlyBefore.push(quotation);
      console.log(`    >>> only mail from BEFORE the quotation date - outside the verifier's window`);
    }
  }

  // The verifier's own search, run against the same folders, on a few of the ones the audit
  // found and it did not. Its result is what says whether the criteria are too narrow or the
  // search itself is failing quietly.
  if (missed.length > 0 && searchable.length > 0) {
    console.log("");
    console.log("=".repeat(78));
    console.log(`CROSS-CHECK - running the verifier's OWN search on ${Math.min(CROSS_CHECK, missed.length)} of them`);
    console.log("=".repeat(78));
    const sample = missed.slice(0, CROSS_CHECK);
    const byMailbox = new Map<string, string[]>();
    for (const entry of searchable) {
      if (!byMailbox.has(entry.email)) byMailbox.set(entry.email, []);
      byMailbox.get(entry.email)!.push(entry.folder);
    }
    for (const [email, folders] of byMailbox) {
      const pass = mailboxPassword(email);
      if (!pass) continue;
      const client = new ImapFlow({
        host, port, secure: true, auth: { user: email, pass },
        logger: false, tls: { rejectUnauthorized: false }, socketTimeout: 5 * 60_000,
      });
      client.on("error", () => { /* reported by the search itself */ });
      try {
        await client.connect();
        for (const folder of folders) {
          const lock = await client.getMailboxLock(folder);
          try {
            for (const { quotation } of sample) {
              const line = await verifierSearch(client, quotation);
              if (line) console.log(`  ${quotation.quotationNo} in ${email}/${folder}: ${line}`);
            }
          } finally {
            lock.release();
          }
        }
      } catch (error) {
        console.log(`  ${email}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        try { await client.logout(); } catch { /* already closed */ }
      }
    }
  }

  console.log("");
  console.log("=".repeat(78));
  console.log("VERDICT");
  console.log("=".repeat(78));
  console.log("");
  console.log(`  ${missed.length} quotation(s): the mail IS in a Sent folder, dated on or after the`);
  console.log(`      quotation, and they are still showing Created. The verifier is at fault`);
  console.log(`      for these - the cross-check above says which of its assumptions broke.`);
  if (missed.length > 0) console.log(`      ${missed.slice(0, 12).map((m) => m.quotation.quotationNo).join(", ")}`);
  console.log("");
  console.log(`  ${onlyBefore.length} quotation(s): the mail is there, but every copy predates the date the`);
  console.log(`      quotation carries - sent first, typed into OpenCall afterwards. Widening`);
  console.log(`      the window fixes these.`);
  if (onlyBefore.length > 0) console.log(`      ${onlyBefore.slice(0, 12).map((q) => q.quotationNo).join(", ")}`);
  console.log("");
  console.log(`  ${noTrace.length} quotation(s): no mail to that customer, and nothing carrying that work`);
  console.log(`      order, case ID or quotation number, in ANY Sent folder read above. If`);
  console.log(`      every quotation really does go out by mail, these were sent from`);
  console.log(`      somewhere that does not file a copy on the server - Outlook on POP3,`);
  console.log(`      or a personal address - and no search of these mailboxes will find them.`);
  if (noTrace.length > 0) console.log(`      ${noTrace.slice(0, 12).map((q) => q.quotationNo).join(", ")}`);
  console.log("");
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabasePool();
  });
