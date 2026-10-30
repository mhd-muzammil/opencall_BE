/**
 * The Message-ID a quotation mail sent from here carries, and the two ways it is read back.
 *
 * `<quotation.<id>.<time>@renderways.in>`. The customer never sees it, the mail server keeps
 * it, and a reply carries it back in In-Reply-To and References. The trade desk's subjects
 * name no quotation number, and the Part subject no work order either, so this id is what
 * ties a mail — and every reply to it — to the quotation it carried:
 *   - the Sent-folder check reads a sent mail's own id, to tell one quotation's mail from
 *     another's to the same customer (quotationSendVerifier.pickSentMail);
 *   - the mail ingest reads a reply's thread headers, to place the reply on the quotation's
 *     work order when nothing in its subject or text names one (inboundEmailService).
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function quotationMessageId(quotationId: string, now = Date.now()): string {
  return `<quotation.${quotationId.toLowerCase()}.${now}@renderways.in>`;
}

/**
 * The quotation a single Message-ID names, or null. Trimmed first: the id is long enough
 * that its header is folded onto a second line, and a reader may hand it back with the
 * fold's leading space.
 */
export function quotationOfMessageId(messageId: string | null | undefined): string | null {
  const match = new RegExp(`^<?quotation\\.(${UUID})\\.`, "i").exec(String(messageId ?? "").trim());
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Every quotation a received mail's headers name: its own Message-ID (our copy of a mail we
 * sent, as a branch mailbox on CC receives it), In-Reply-To and References (a reply, however
 * deep in the thread). Header names lower-cased, as the message parser gives them.
 */
export function quotationIdsInHeaders(headers: Readonly<Record<string, string | undefined>>): string[] {
  const text = ["message-id", "in-reply-to", "references"].map((name) => headers[name] ?? "").join(" ");
  const ids = new Set<string>();
  for (const match of text.matchAll(new RegExp(`<quotation\\.(${UUID})\\.`, "gi"))) {
    ids.add(match[1]!.toLowerCase());
  }
  return [...ids];
}
