import "dotenv/config";
import { writeFileSync } from "node:fs";
import { ImapFlow } from "imapflow";
import type pg from "pg";
import { closeDatabasePool, pool } from "../config/database.js";
import { toDisplayHtml } from "../services/inboundEmail/htmlSanitizer.js";
import { mailboxPassword } from "../services/inboundEmail/mailboxCredentials.js";
import { parseMessageSource, type ParsedMessage } from "../services/inboundEmail/messageParser.js";
import { legacySanitizeEmailHtml } from "./legacyEmailSanitizer.js";

/**
 * Show already-stored Customer Emails the way the fixed reader shows new ones.
 *
 * Until the fidelity fix, every Outlook mail was stored with its stylesheet emptied (so it
 * read double-spaced, in the wrong font), and a plain-text mail had no display copy at all
 * (so the reader fell back to the copy cleaned for matching, which loses whole threads).
 * Nothing ever rewrites a stored body, so this re-reads each affected message from its
 * mailbox and stores what the current code makes of it.
 *
 * Safe by construction:
 * - A DRY RUN unless --apply is given: it reads and counts, and changes nothing.
 * - Read-only on the mail server: INBOX is opened with EXAMINE and bodies are fetched with
 *   BODY.PEEK, so nothing is marked read, moved or deleted.
 * - A row is rewritten only when the fetched message is the same message (its Message-ID
 *   matches the stored one) AND the old rule, run again on it, gives back exactly what is
 *   stored. That proves the row is what the old code made of this very message, so the old
 *   body can always be rebuilt the same way.
 * - Each UPDATE carries the md5 of the body it replaces; a row that changed meanwhile is
 *   left alone.
 * - One run at a time (an advisory lock), one mailbox and one batch at a time, with a pause
 *   between batches.
 *
 * Mail stored before 12-16 Aug 2026 never had its HTML kept. Those rows fail the gate by
 * design ("never kept") and are written only with --include-never-kept, which also stores
 * the inline pictures their HTML points at — never their other files, so the quotation
 * payment check sees exactly what it saw before.
 *
 * In the API container:
 *   node dist/scripts/refreshInboundEmailBodies.js                     dry run, every mailbox
 *   node dist/scripts/refreshInboundEmailBodies.js --apply             write
 *   options: --mailbox=<address>  --limit=<n>  --include-never-kept
 *            --all (every stored message, not just the ones known to be affected)
 */

export type RefreshClass =
  | "current"
  | "refresh"
  | "never-kept"
  | "different"
  | "not-found"
  | "no-message-id"
  | "unreadable";

export interface Classified {
  kind: RefreshClass;
  /** What the current code shows for this message; set for refresh and never-kept. */
  html?: string;
}

/** The decision for one stored row, given the message it came from. Pure, so it is tested. */
export function classify(storedHtml: string, parsed: Pick<ParsedMessage, "html" | "text">): Classified {
  const html = toDisplayHtml(parsed);
  if (storedHtml === html) return { kind: "current" };
  const old = legacySanitizeEmailHtml(parsed.html);
  if (storedHtml === old) return { kind: "refresh", html };
  if (storedHtml === "" && old !== "") return { kind: "never-kept", html };
  return { kind: "different" };
}

/** Ids the ingest makes up when a message has no Message-ID; nothing can be matched on them. */
export function isMadeUpMessageId(messageId: string): boolean {
  return /^(?:uid|cab|verify)-\d+@/i.test(messageId) || !messageId.trim();
}

export interface FetchedMessage {
  uid: number;
  messageId: string;
  source: Buffer;
}

/** One mailbox, open for reading. The IMAP one in production; a fixture in tests. */
export interface MailboxReader {
  /** Sizes of the messages at these INBOX UIDs; a UID that is gone is simply absent. */
  sizes(uids: number[]): Promise<Map<number, number>>;
  /** The messages at these INBOX UIDs, read without marking anything. */
  read(uids: number[]): Promise<FetchedMessage[]>;
  /** The INBOX UID that holds this Message-ID now, if any. */
  findUid(messageId: string): Promise<number | null>;
  close(): Promise<void>;
}

export interface RefreshOptions {
  apply: boolean;
  mailbox: string | null;
  limit: number | null;
  all: boolean;
  includeNeverKept: boolean;
  /** Between batches, so a shared mail host is never hammered. */
  pauseMs: number;
  /** Where the per-row record goes; nothing is written there when null. */
  logPath: string | null;
}

interface Candidate {
  id: string;
  mailboxEmail: string;
  imapUid: number;
  messageId: string;
  bodyHtml: string;
  bodyMd5: string;
}

const BATCH_MESSAGES = 20;
const BATCH_BYTES = 48 * 1024 * 1024;
const LOCK_NAME = "refreshInboundEmailBodies";

const ALL_CLASSES: RefreshClass[] = [
  "current",
  "refresh",
  "never-kept",
  "different",
  "not-found",
  "no-message-id",
  "unreadable",
];

function emptyCounts(): Record<RefreshClass, number> {
  return Object.fromEntries(ALL_CLASSES.map((kind) => [kind, 0])) as Record<RefreshClass, number>;
}

async function loadCandidates(db: pg.PoolClient, options: RefreshOptions): Promise<Candidate[]> {
  // By default only the two kinds of row the old code is known to have spoilt: an Outlook
  // stylesheet left empty, and no display copy at all.
  const result = await db.query<{
    id: string;
    mailbox_email: string;
    imap_uid: string;
    message_id: string;
    body_html: string;
    body_md5: string;
  }>(
    `SELECT id::TEXT, mailbox_email, imap_uid::TEXT, message_id, body_html, md5(body_html) AS body_md5
       FROM inbound_emails
      WHERE imap_uid IS NOT NULL
        AND ($1::TEXT IS NULL OR mailbox_email = $1)
        AND ($2::BOOLEAN OR body_html = '' OR body_html ~* '<style[^>]*>\\s*</style>')
      ORDER BY mailbox_email, imap_uid
      LIMIT $3`,
    [options.mailbox, options.all, options.limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    mailboxEmail: row.mailbox_email,
    imapUid: Number(row.imap_uid),
    messageId: row.message_id,
    bodyHtml: row.body_html,
    bodyMd5: row.body_md5,
  }));
}

/** Batches of at most BATCH_MESSAGES and BATCH_BYTES; a single bigger message goes alone. */
function batchesOf(uids: number[], sizes: Map<number, number>): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let bytes = 0;
  for (const uid of uids) {
    const size = sizes.get(uid) ?? 0;
    if (current.length > 0 && (current.length >= BATCH_MESSAGES || bytes + size > BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(uid);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function writeRow(
  db: pg.PoolClient,
  candidate: Candidate,
  decision: Classified,
  parsed: ParsedMessage,
): Promise<boolean> {
  await db.query("BEGIN");
  try {
    const updated = await db.query(
      `UPDATE inbound_emails SET body_html = $2 WHERE id = $1 AND md5(body_html) = $3`,
      [candidate.id, decision.html, candidate.bodyMd5],
    );
    if (updated.rowCount !== 1) {
      await db.query("ROLLBACK");
      return false;
    }
    if (decision.kind === "never-kept") {
      // Only the pictures the body draws, so its cid: references resolve. Other files stay
      // out: the quotation payment check reads them, and it must see what it saw before.
      for (const file of parsed.attachments) {
        if (!file.isInline || !file.contentId || file.content.length === 0) continue;
        await db.query(
          `INSERT INTO inbound_email_attachments
             (inbound_email_id, content_id, filename, mime_type, size_bytes, is_inline, content)
           SELECT $1, $2, $3, $4, $5, TRUE, $6
            WHERE NOT EXISTS (SELECT 1 FROM inbound_email_attachments
                               WHERE inbound_email_id = $1 AND content_id = $2)`,
          [candidate.id, file.contentId, file.filename, file.mimeType, file.sizeBytes, file.content],
        );
      }
    }
    await db.query("COMMIT");
    return true;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RefreshSummary {
  counts: Record<RefreshClass, number>;
  written: number;
  changedMeanwhile: number;
  failed: number;
  mailboxesSkipped: string[];
}

/**
 * The whole run. `openMailbox` returns null when a mailbox cannot be opened (no password,
 * login refused); its rows are then reported, not guessed at.
 */
export async function runRefresh(
  options: RefreshOptions,
  openMailbox: (mailboxEmail: string) => Promise<MailboxReader | null>,
  log: (line: string) => void = console.log,
): Promise<RefreshSummary | null> {
  const db = await pool.connect();
  const summary: RefreshSummary = {
    counts: emptyCounts(),
    written: 0,
    changedMeanwhile: 0,
    failed: 0,
    mailboxesSkipped: [],
  };
  const record: string[] = [];
  try {
    const locked = await db.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS ok",
      [LOCK_NAME],
    );
    if (!locked.rows[0]?.ok) {
      log("Another refresh is already running. Nothing was done.");
      return null;
    }
    try {
      const candidates = await loadCandidates(db, options);
      log(`${candidates.length} stored message(s) to check${options.all ? " (all)" : ""}.`);

      const byMailbox = new Map<string, Candidate[]>();
      for (const candidate of candidates) {
        const list = byMailbox.get(candidate.mailboxEmail) ?? [];
        list.push(candidate);
        byMailbox.set(candidate.mailboxEmail, list);
      }

      for (const [mailboxEmail, rows] of byMailbox) {
        const counts = emptyCounts();
        const checkable = rows.filter((row) => {
          if (!isMadeUpMessageId(row.messageId)) return true;
          counts["no-message-id"] += 1;
          record.push(`${row.id}\tno-message-id`);
          return false;
        });

        const reader = checkable.length > 0 ? await openMailbox(mailboxEmail) : null;
        if (checkable.length > 0 && !reader) {
          summary.mailboxesSkipped.push(mailboxEmail);
          log(`${mailboxEmail} — could not be opened; its ${checkable.length} row(s) were not checked.`);
          continue;
        }

        try {
          if (reader) {
            // A UID that now holds a different message, or none, is looked up again by its
            // Message-ID; a message filed away from INBOX is simply not found.
            const sizes = await reader.sizes(checkable.map((row) => row.imapUid));
            const batches = batchesOf(
              checkable.map((row) => row.imapUid),
              sizes,
            );
            const byUid = new Map(checkable.map((row) => [row.imapUid, row]));

            for (const [index, uids] of batches.entries()) {
              if (index > 0) await sleep(options.pauseMs);
              const fetched = await reader.read(uids);
              const sourceByUid = new Map(fetched.map((message) => [message.uid, message]));

              for (const uid of uids) {
                const row = byUid.get(uid)!;
                let message = sourceByUid.get(uid);
                if (!message || message.messageId !== row.messageId) {
                  const movedTo = await reader.findUid(row.messageId);
                  const [found] = movedTo ? await reader.read([movedTo]) : [];
                  message = found && found.messageId === row.messageId ? found : undefined;
                }
                if (!message) {
                  counts["not-found"] += 1;
                  record.push(`${row.id}\tnot-found`);
                  continue;
                }

                let parsed: ParsedMessage;
                try {
                  parsed = await parseMessageSource(message.source);
                } catch {
                  counts.unreadable += 1;
                  record.push(`${row.id}\tunreadable`);
                  continue;
                }

                const decision = classify(row.bodyHtml, parsed);
                counts[decision.kind] += 1;
                const writable =
                  decision.kind === "refresh" ||
                  (decision.kind === "never-kept" && options.includeNeverKept);
                if (!options.apply || !writable) {
                  record.push(`${row.id}\t${decision.kind}${writable ? "\twould-write" : ""}`);
                  continue;
                }
                try {
                  if (await writeRow(db, row, decision, parsed)) {
                    summary.written += 1;
                    record.push(`${row.id}\t${decision.kind}\twritten\t${row.bodyMd5}`);
                  } else {
                    summary.changedMeanwhile += 1;
                    record.push(`${row.id}\t${decision.kind}\tchanged-meanwhile`);
                  }
                } catch (error) {
                  summary.failed += 1;
                  record.push(`${row.id}\t${decision.kind}\tfailed`);
                  log(`  ${row.id} — write failed: ${error instanceof Error ? error.message : String(error)}`);
                }
              }
            }
          }
        } catch (error) {
          summary.mailboxesSkipped.push(mailboxEmail);
          log(`${mailboxEmail} — stopped: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          await reader?.close();
        }

        for (const kind of ALL_CLASSES) summary.counts[kind] += counts[kind];
        log(
          `${mailboxEmail} — ` +
            ALL_CLASSES.filter((kind) => counts[kind] > 0)
              .map((kind) => `${kind} ${counts[kind]}`)
              .join(", "),
        );
      }
    } finally {
      await db.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]);
    }
  } finally {
    db.release();
    if (options.logPath && record.length > 0) {
      writeFileSync(options.logPath, `${record.join("\n")}\n`, "utf8");
    }
  }

  const total = summary.counts;
  log("");
  log(
    `Checked: refresh ${total.refresh}, never kept ${total["never-kept"]}, already current ${total.current}, ` +
      `left alone ${total.different} (stored body is not what the old code made), ` +
      `not in INBOX ${total["not-found"]}, no Message-ID ${total["no-message-id"]}, unreadable ${total.unreadable}.`,
  );
  if (options.apply) {
    log(
      `APPLIED: ${summary.written} row(s) written` +
        (summary.changedMeanwhile ? `, ${summary.changedMeanwhile} skipped because they changed meanwhile` : "") +
        (summary.failed ? `, ${summary.failed} failed` : "") +
        ".",
    );
  } else {
    const would = total.refresh + (options.includeNeverKept ? total["never-kept"] : 0);
    log(`DRY RUN — nothing was changed. ${would} row(s) would be written with --apply.`);
    if (!options.includeNeverKept && total["never-kept"] > 0) {
      log(`${total["never-kept"]} never-kept row(s) are written only with --include-never-kept.`);
    }
  }
  if (summary.mailboxesSkipped.length > 0) log(`Not checked: ${summary.mailboxesSkipped.join(", ")}`);
  if (options.logPath && record.length > 0) log(`Per-row record: ${options.logPath}`);
  return summary;
}

/** The production reader: INBOX opened read-only, one connection for the whole mailbox. */
async function openImapMailbox(mailboxEmail: string): Promise<MailboxReader | null> {
  const host = process.env.MAIL_IMAP_HOST ?? "";
  const pass = mailboxPassword(mailboxEmail);
  if (!host || !pass) return null;
  const client = new ImapFlow({
    host,
    port: Number(process.env.MAIL_IMAP_PORT ?? 993),
    secure: true,
    auth: { user: mailboxEmail, pass },
    logger: false,
    // The mailboxes are on shared hosting with a self-signed chain on some hostnames.
    tls: { rejectUnauthorized: false },
    socketTimeout: 5 * 60_000,
  });
  // An 'error' with no listener ends the process — the same rule as everywhere else an
  // ImapFlow client is built.
  client.on("error", (error: unknown) => {
    console.error(`  IMAP error on ${mailboxEmail}:`, error instanceof Error ? error.message : error);
  });
  try {
    await client.connect();
  } catch {
    return null;
  }
  // EXAMINE, not SELECT: the mailbox is opened read-only and nothing can change in it.
  const lock = await client.getMailboxLock("INBOX", { readOnly: true });

  return {
    async sizes(uids) {
      const sizes = new Map<number, number>();
      if (uids.length === 0) return sizes;
      for await (const message of client.fetch(uids, { uid: true, size: true }, { uid: true })) {
        sizes.set(Number(message.uid), Number(message.size) || 0);
      }
      return sizes;
    },
    async read(uids) {
      const messages: FetchedMessage[] = [];
      if (uids.length === 0) return messages;
      // `source` is fetched as BODY.PEEK[], so nothing is marked as read.
      for await (const message of client.fetch(uids, { uid: true, envelope: true, source: true }, { uid: true })) {
        messages.push({
          uid: Number(message.uid),
          messageId: String(message.envelope?.messageId ?? ""),
          source: message.source ?? Buffer.from([]),
        });
      }
      return messages;
    },
    async findUid(messageId) {
      const found = await client.search({ header: { "message-id": messageId } }, { uid: true });
      const list = Array.isArray(found) ? found : [];
      return list.length === 1 ? Number(list[0]) : null;
    },
    async close() {
      lock.release();
      try {
        await client.logout();
      } catch {
        /* already closed */
      }
    },
  };
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() : null;
}

async function main(): Promise<void> {
  const limitArg = Number(value("limit"));
  const options: RefreshOptions = {
    apply: flag("apply"),
    mailbox: value("mailbox")?.toLowerCase() || null,
    limit: Number.isInteger(limitArg) && limitArg > 0 ? limitArg : null,
    all: flag("all"),
    includeNeverKept: flag("include-never-kept"),
    pauseMs: 1500,
    logPath: `/tmp/refresh-inbound-email-bodies-${new Date().toISOString().replace(/[:.]/g, "-")}.tsv`,
  };
  console.log("=".repeat(74));
  console.log(
    `CUSTOMER EMAILS — show stored mail as the current reader does (${options.apply ? "APPLY" : "DRY RUN"})`,
  );
  console.log("The mail server is only read: nothing is marked read, moved or deleted.");
  console.log("=".repeat(74));
  await runRefresh(options, openImapMailbox);
}

// Run only as a script, never when a test imports this file for classify().
if (process.argv[1] && /refreshInboundEmailBodies\.(?:js|ts)$/.test(process.argv[1])) {
  main()
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      void closeDatabasePool();
    });
}
