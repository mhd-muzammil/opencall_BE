import { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";

/**
 * Put a copy of every mail this system sends into the mailbox's own Sent folder.
 *
 * Without this, a mail sent from OpenCall exists nowhere the team can see it except
 * OpenCall's own record: open webmail on `salem@renderways.in`, look in Sent, and the
 * message is not there. Anyone checking the mailbox directly — or handing it to HP as
 * evidence of what was sent — would conclude it never went.
 *
 * SMTP does not do this. A message is only in Sent because the client that sent it also
 * APPENDed a copy over IMAP, which is exactly what Outlook does and what this does.
 *
 * BEST EFFORT, ALWAYS. The mail has already reached the customer by the time this runs, so
 * a failure here must never surface as "send failed" — that would invite a second send of
 * something that already went out. It logs and returns.
 */

/** Folder names cPanel/Dovecot use when the server does not advertise SPECIAL-USE. */
const SENT_NAMES = [
  "sent",
  "sent items",
  "sent mail",
  "sent messages",
  "inbox.sent",
  "inbox/sent",
];

/** Build the exact bytes that will be both sent and filed, so the two cannot diverge. */
export async function buildRawMessage(options: Mail.Options): Promise<Buffer> {
  return new MailComposer(options).compile().build();
}

/**
 * Choose the Sent folder from a mailbox listing.
 *
 * `specialUse` is what a well-behaved server reports and is always preferred — the folder
 * may be called anything in any language. The name list is the fallback for servers that
 * do not advertise SPECIAL-USE, which includes some cPanel installations.
 *
 * Split out from the IMAP call so the choice can be tested without a mail server.
 */
export function pickSentFolder(
  boxes: ReadonlyArray<{ path?: string; specialUse?: string }>,
): string | null {
  const flagged = boxes.find((box) => box.specialUse === "\\Sent");
  if (flagged?.path) return flagged.path;

  const named = boxes.find((box) =>
    SENT_NAMES.includes(String(box.path ?? "").trim().toLowerCase()),
  );
  return named?.path ?? null;
}

export async function resolveSentFolder(client: ImapFlow): Promise<string | null> {
  return pickSentFolder(await client.list());
}

export async function archiveToSentFolder(input: {
  mailboxEmail: string;
  raw: Buffer;
}): Promise<boolean> {
  const host = process.env.MAIL_IMAP_HOST ?? "";
  const port = Number(process.env.MAIL_IMAP_PORT ?? 993);
  const pass = process.env.MAIL_PASSWORD ?? "";
  if (!host || !pass) return false;

  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user: input.mailboxEmail, pass },
    logger: false,
    // Same shared-hosting certificate situation as the ingest side.
    tls: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const folder = await resolveSentFolder(client);
    if (!folder) {
      console.error(`[sentFolder] no Sent folder found for ${input.mailboxEmail}`);
      return false;
    }
    // Marked read: the team sent it, so it must not show up as an unread message.
    await client.append(folder, input.raw, ["\\Seen"]);
    return true;
  } catch (error) {
    console.error(`[sentFolder] could not file a copy for ${input.mailboxEmail}:`, error);
    return false;
  } finally {
    try {
      await client.logout();
    } catch {
      // The copy is already filed or already lost; a noisy logout adds nothing.
    }
  }
}
