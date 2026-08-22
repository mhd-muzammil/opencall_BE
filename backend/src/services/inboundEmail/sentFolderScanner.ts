import type { ImapFlow } from "imapflow";

/**
 * Every folder in a mailbox that holds sent mail — not just the first one found.
 *
 * Filing a copy of an outgoing mail only needs one folder, and `pickSentFolder` answers that
 * question correctly: the one the server flags as \Sent, or the one named like it. READING
 * the history back is a different question, and the same answer is wrong for it.
 *
 * A mailbox that has been used from more than one place has more than one Sent folder.
 * cPanel's webmail files into INBOX.Sent. Outlook, unless told otherwise, makes its own
 * INBOX.Sent Items and files there. A phone set up by hand can produce a third. Only one of
 * those carries the \Sent flag, so a reader that stops at the first match is looking at part
 * of the history and concluding the rest never happened — a quotation mailed from Outlook
 * reads as never sent.
 *
 * So this returns all of them, flagged one first. The caller opens each in turn; a folder
 * that is empty or unopenable costs one round trip and nothing else.
 *
 * Split from the IMAP call so the choice can be tested without a mail server.
 */

/**
 * The last segment of a folder path, under either separator.
 *
 * cPanel puts everything under an INBOX namespace, so the folder called Sent is
 * `INBOX.Sent`; other servers use `/`, and some use neither. Only the leaf is a name someone
 * chose, which is the only part worth matching on.
 */
function leafName(path: string): string {
  const parts = String(path ?? "").split(/[./]/);
  return (parts[parts.length - 1] ?? "").trim();
}

/**
 * A leaf that names a Sent folder.
 *
 * Anchored, with a word boundary: "Sent", "Sent Items", "Sent Mail" and "Sent Messages" all
 * match, and "Sentinel" does not. Deliberately not a substring test — "Unsent drafts" is not
 * somewhere mail was sent from.
 */
function looksSent(leaf: string): boolean {
  return /^sent(\b|$)/i.test(leaf);
}

export function pickSentFolders(
  boxes: ReadonlyArray<{ path?: string; specialUse?: string }>,
): string[] {
  const flagged: string[] = [];
  const named: string[] = [];

  for (const box of boxes) {
    const path = String(box.path ?? "").trim();
    if (!path) continue;
    if (box.specialUse === "\\Sent") {
      flagged.push(path);
      continue;
    }
    if (looksSent(leafName(path))) named.push(path);
  }

  // Flagged first: it is the one the server itself calls Sent, so it is where most of the
  // history is and where a search is most likely to end early. Then the rest, deduplicated —
  // a server that both flags a folder and names it Sent must not be searched twice.
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const path of [...flagged, ...named]) {
    if (seen.has(path)) continue;
    seen.add(path);
    ordered.push(path);
  }
  return ordered;
}

export async function listSentFolders(client: ImapFlow): Promise<string[]> {
  return pickSentFolders(await client.list());
}
