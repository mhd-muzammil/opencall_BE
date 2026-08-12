/**
 * What Compose will and will not send.
 *
 * Kept pure and separate from the service so every rule below is unit-testable without a
 * database or an SMTP server. These are the only checks between a typed address and a real
 * mail leaving the company's domain, so they are deliberately conservative: a rejected
 * send costs someone a retype, a wrong one reaches a stranger over the company's name.
 */

/** Enough for a normal thread; far short of anything that would look like a mailshot. */
export const MAX_RECIPIENTS = 25;
/** cPanel shared hosting will refuse well before this, but the cap is ours to state. */
export const MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_SUBJECT_LENGTH = 300;
export const MAX_BODY_LENGTH = 50_000;

// Intentionally plain: local@domain.tld with no spaces or angle brackets. Anything the
// user pasted from Outlook ("Name <a@b.com>") is unwrapped before this sees it.
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i;

/** Split on separators that are not inside `<...>`, so an address is never cut in half. */
function splitOutsideBrackets(raw: string): string[] {
  const pieces: string[] = [];
  let current = "";
  let inBrackets = false;
  for (const char of raw) {
    if (char === "<") inBrackets = true;
    else if (char === ">") inBrackets = false;

    if (!inBrackets && (char === "," || char === ";" || char === "\n" || char === "\r")) {
      pieces.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  pieces.push(current);
  return pieces;
}

/**
 * Split a recipient field the way people actually type one: commas, semicolons and
 * newlines all separate, and `Name <addr>` yields just the address.
 *
 * The awkward case is a display name Outlook did not quote — "Sharma, Bhupesh
 * <bhupesh.sharma@hp.com>". Its comma is a real separator everywhere else, so splitting
 * naively invented a recipient called "sharma". A bare token is therefore dropped when the
 * NEXT token carries an angle-bracketed address: that is the only shape where leading
 * debris is a name rather than something the sender meant to type. Anything else with no
 * "@" is kept, so a genuine typo still fails validation loudly instead of vanishing.
 */
export function parseRecipients(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (value: string): void => {
    const cleaned = value.trim().replace(/^["']|["']$/g, "").trim().toLowerCase();
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    out.push(cleaned);
  };

  const tokens = splitOutsideBrackets(String(raw ?? ""));
  for (let index = 0; index < tokens.length; index += 1) {
    const token = (tokens[index] ?? "").trim();
    if (!token) continue;

    const angled = /<([^>]*)>/.exec(token);
    if (angled) {
      add(angled[1] ?? "");
      continue;
    }
    if (!token.includes("@") && /<[^>]*>/.test(tokens[index + 1] ?? "")) continue;
    add(token);
  }
  return out;
}

export interface ComposeInput {
  fromEmail: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  attachmentBytes: number;
}

export interface ComposeCheck {
  /** Null when the mail may be sent; otherwise the reason to show the sender. */
  error: string | null;
  to: string[];
  cc: string[];
}

export function checkCompose(input: ComposeInput): ComposeCheck {
  const to = parseRecipients(input.to);
  const cc = parseRecipients(input.cc);

  if (!input.fromEmail.includes("@")) {
    return { error: "Choose which mailbox to send from", to, cc };
  }
  if (to.length === 0) {
    return { error: "Add at least one recipient", to, cc };
  }

  const bad = [...to, ...cc].filter((address) => !EMAIL.test(address));
  if (bad.length > 0) {
    return { error: `Not a valid email address: ${bad.join(", ")}`, to, cc };
  }
  if (to.length + cc.length > MAX_RECIPIENTS) {
    return {
      error: `Too many recipients (${to.length + cc.length}). The limit is ${MAX_RECIPIENTS}.`,
      to,
      cc,
    };
  }

  // A blank subject is what a spam filter scores hardest against, and it makes the Sent
  // list unreadable later.
  if (!input.subject.trim()) {
    return { error: "Add a subject", to, cc };
  }
  if (input.subject.length > MAX_SUBJECT_LENGTH) {
    return { error: `The subject is too long (max ${MAX_SUBJECT_LENGTH} characters)`, to, cc };
  }
  if (!input.body.trim()) {
    return { error: "The message is empty", to, cc };
  }
  if (input.body.length > MAX_BODY_LENGTH) {
    return { error: `The message is too long (max ${MAX_BODY_LENGTH} characters)`, to, cc };
  }
  if (input.attachmentBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    const mb = Math.round(MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024));
    return { error: `The attachments are over ${mb} MB in total`, to, cc };
  }

  return { error: null, to, cc };
}
