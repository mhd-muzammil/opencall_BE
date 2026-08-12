import { simpleParser } from "mailparser";

/**
 * Full MIME parsing for the reading pane.
 *
 * The hand-rolled body cleaner in `emailMatcher` stays — it is what matching and
 * escalation detection read, and those rules are tuned against flattened plain text. This
 * module is for DISPLAY: it recovers the HTML part and the attachment bytes so a message
 * can be shown the way the sender wrote it, complete with the inline signature images that
 * previously rendered as "[cid:image001.png@01DD2A69.E32ECA10]".
 *
 * Hand-rolling this was not an option. Real mail nests multipart/related inside
 * multipart/alternative, encodes each part differently, declares charsets per part and
 * addresses inline pictures by Content-ID — every one of which is a way to silently lose
 * what the customer sent. `mailparser` is the same library the nodemailer project
 * maintains, and it is only ever handed bytes, never asked to fetch anything.
 */

/** Per-file ceiling. Anything larger is recorded by name but its bytes are dropped. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Ceiling for one message's attachments together, so a single mail cannot bloat the table. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface ParsedAttachment {
  /** RFC 2392 Content-ID with angle brackets stripped; empty unless the body references it. */
  contentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isInline: boolean;
  /** Empty when the file was over the size ceiling — the row still records that it existed. */
  content: Buffer;
  /** True when the bytes were dropped for size, so the UI can say so instead of offering a broken download. */
  skippedForSize: boolean;
}

export interface ParsedMessage {
  /** Lower-cased header names → value, matching what the auto-reply detector expects. */
  headers: Record<string, string>;
  fromEmail: string;
  fromName: string;
  subject: string;
  receivedAt: Date | null;
  messageId: string;
  /** The text/plain part, already decoded. Empty when the message was HTML only. */
  text: string;
  /** The text/html part, already decoded, cid: references untouched. */
  html: string;
  attachments: ParsedAttachment[];
}

/** Strip the angle brackets Content-ID is conventionally wrapped in. */
function normaliseContentId(value: string | undefined | null): string {
  return String(value ?? "").replace(/^<|>$/g, "").trim();
}

export async function parseMessageSource(source: Buffer | string): Promise<ParsedMessage> {
  const parsed = await simpleParser(source, {
    // No network, ever: a mail body must not be able to make the server fetch anything.
    skipImageLinks: true,
  });

  const headers: Record<string, string> = {};
  for (const [key, value] of parsed.headers) {
    headers[String(key).toLowerCase()] =
      typeof value === "string" ? value : String((value as { value?: unknown })?.value ?? value);
  }

  const firstFrom = parsed.from?.value?.[0];

  let running = 0;
  const attachments: ParsedAttachment[] = [];
  for (const item of parsed.attachments ?? []) {
    const content = Buffer.isBuffer(item.content) ? item.content : Buffer.from([]);
    const sizeBytes = item.size ?? content.length;
    const overSize =
      sizeBytes > MAX_ATTACHMENT_BYTES || running + sizeBytes > MAX_TOTAL_ATTACHMENT_BYTES;
    if (!overSize) running += sizeBytes;

    attachments.push({
      contentId: normaliseContentId(item.cid ?? item.contentId),
      filename: String(item.filename ?? "").trim(),
      mimeType: String(item.contentType ?? "application/octet-stream"),
      sizeBytes,
      // An inline picture is one the body points at, or one the sender marked inline.
      isInline: Boolean(item.related) || item.contentDisposition === "inline",
      content: overSize ? Buffer.from([]) : content,
      skippedForSize: overSize,
    });
  }

  return {
    headers,
    fromEmail: String(firstFrom?.address ?? "").toLowerCase(),
    fromName: String(firstFrom?.name ?? ""),
    subject: String(parsed.subject ?? "").trim(),
    receivedAt: parsed.date ?? null,
    messageId: normaliseContentId(parsed.messageId),
    text: String(parsed.text ?? ""),
    html: typeof parsed.html === "string" ? parsed.html : "",
    attachments,
  };
}
