/**
 * Spotting an escalation in an inbound customer email.
 *
 * Pure function — no DB, no IMAP — so the rules are unit-testable and can be tuned without
 * touching the ingest path.
 *
 * Tuned to how escalations actually read in this business, not to generic "angry email"
 * wording. HP calls an escalated call an **Elevation** (the RTPL status list has
 * "Elevation HP Pending" / "Elevation Part Pending"), and real escalations arrive from an
 * "Escalation Manager" with that phrase in the signature. Those are the strong signals; the
 * impatience words are only a watch.
 */

export type EscalationLevel = "NONE" | "WATCH" | "HIGH";

export interface EscalationResult {
  level: EscalationLevel;
  /** Short human-readable reasons, so the UI can say WHY it was flagged. */
  reasons: string[];
}

export const NO_ESCALATION: EscalationResult = { level: "NONE", reasons: [] };

/** In the subject line these are decisive: the sender has named it an escalation. */
const STRONG_SUBJECT = [
  { re: /\belevation\b/i, why: "“Elevation” in subject" },
  { re: /\bescalat(e|ed|ion|ing)\b/i, why: "“Escalation” in subject" },
];

/**
 * Anywhere in the message these mean somebody senior has taken the call over.
 *
 * The legal rule is deliberately narrow. A bare `\blegal\b` flagged 51 of 67 real messages
 * HIGH, because HP's standard footer ends "Legal Disclaimer :" — the word alone means
 * nothing. Only an actual threat of proceedings counts.
 */
const STRONG_BODY = [
  { re: /escalation\s+manager/i, why: "From an Escalation Manager" },
  {
    re: /\b(consumer\s+court|legal\s+(notice|action|proceeding|recourse)|take\s+legal)\b/i,
    why: "Threat of legal action",
  },
  { re: /\b(elevation)\s+(call|case|ticket)\b/i, why: "“Elevation call” in body" },
];

/**
 * Everything from the confidentiality/disclaimer footer onwards.
 *
 * These boilerplate blocks are what produced the false positives: HP's footer carries both
 * "Legal Disclaimer" and "delete immediately", so a routine acknowledgement read as an
 * urgent legal escalation. The customer's own words always come before it.
 */
const DISCLAIMER_START =
  /^\s*(?:legal\s+disclaimer|disclaimer|confidentiality\s+(?:notice|statement)|this\s+e-?mail\s+(?:and|is)|the\s+information\s+(?:contained\s+)?in\s+this\s+e-?mail|if\s+you\s+are\s+not\s+the\s+intended\s+recipient)\b/im;

export function stripDisclaimer(body: string): string {
  const text = String(body ?? "");
  const match = DISCLAIMER_START.exec(text);
  return match ? text.slice(0, match.index) : text;
}

/** Impatience: worth a look, not proof on its own. */
const WATCH_TERMS = [
  { re: /\burgent(ly)?\b/i, why: "Urgent" },
  { re: /\b(immediate(ly)?|asap|at\s+the\s+earliest)\b/i, why: "Asked for immediate action" },
  { re: /\b(still\s+(not|pending|waiting)|no\s+response|not\s+yet\s+(resolved|done))\b/i, why: "Chasing — no response yet" },
  { re: /\b(third|3rd|fourth|4th)\s+(time|reminder|follow[\s-]?up)\b/i, why: "Repeat follow-up" },
  { re: /\b(disappoint(ed|ing)?|unacceptable|poor\s+service|worst|frustrat(ed|ing))\b/i, why: "Dissatisfaction" },
  { re: /\breminder\b/i, why: "Reminder" },
];

/**
 * Classify one message.
 *
 * HIGH when the sender has explicitly named it an escalation/elevation — in the subject, or
 * by writing as an Escalation Manager. WATCH when the wording only shows impatience. The
 * distinction matters: HIGH is what a coordinator must pick up first, and flagging every
 * "please treat as urgent" as HIGH would drown that out.
 *
 * Machine mail is never an escalation — HP's own auto-acknowledgements quote the word.
 */
export function detectEscalation(input: {
  subject: string;
  body: string;
  isAutoReply?: boolean;
}): EscalationResult {
  if (input.isAutoReply) return NO_ESCALATION;

  const subject = String(input.subject ?? "");
  // Judge only what the sender wrote — the boilerplate footer is not their words.
  const body = stripDisclaimer(String(input.body ?? ""));
  const both = `${subject}\n${body}`;

  const reasons: string[] = [];
  let strong = false;

  for (const rule of STRONG_SUBJECT) {
    if (rule.re.test(subject)) {
      strong = true;
      reasons.push(rule.why);
    }
  }
  for (const rule of STRONG_BODY) {
    if (rule.re.test(body)) {
      strong = true;
      reasons.push(rule.why);
    }
  }
  for (const rule of WATCH_TERMS) {
    if (rule.re.test(both)) reasons.push(rule.why);
  }

  if (strong) return { level: "HIGH", reasons };
  if (reasons.length > 0) return { level: "WATCH", reasons };
  return NO_ESCALATION;
}
