/**
 * Building the reply draft for a customer email.
 *
 * Pure functions — no DB, no SMTP — so the wording and, more importantly, the rules about
 * WHEN a reply may exist at all are unit-testable.
 *
 * Stage 2 runs in APPROVAL mode: this only ever produces a draft. Nothing here sends.
 */

export interface CallFacts {
  ticketId: string;
  /** RTPL / current status as the report holds it, e.g. "Part Order Pending". */
  status: string;
  engineer: string;
  product: string;
  customerName: string;
}

export interface DraftInput {
  subject: string;
  fromName: string;
  fromEmail: string;
  regionCode: string;
  /** Null when the message could not be tied to a call. */
  call: CallFacts | null;
  isAutoReply: boolean;
  /** 'HIGH' | 'LOW' | 'NONE' — how sure the match is. */
  matchConfidence: string;
}

/** Why a message may not be replied to. Empty means a draft is allowed. */
export function blockedReason(input: {
  isAutoReply: boolean;
  alreadySent: boolean;
}): string {
  if (input.isAutoReply) {
    return "Auto-generated / no-reply message — replying would start a loop";
  }
  if (input.alreadySent) {
    return "A reply has already been sent for this message";
  }
  return "";
}

/** "Re: x" without stacking a second Re:. */
export function replySubject(subject: string): string {
  const clean = String(subject ?? "").trim();
  if (!clean) return "Re: your service request";
  return /^re\s*:/i.test(clean) ? clean : `Re: ${clean}`;
}

/** First name where we have one, else a neutral greeting — never a raw email address. */
function greetingName(fromName: string, customerName: string): string {
  const name = (customerName || fromName || "").trim();
  if (!name || name.includes("@")) return "Sir/Madam";
  // "L, Santosh" -> "Santosh"; "Ravi Kumar" -> "Ravi"
  const parts = name.includes(",")
    ? name.split(",").map((p) => p.trim()).reverse()
    : name.split(/\s+/);
  return parts[0] || "Sir/Madam";
}

const SIGNATURE = [
  "Renderways Technology Private Limited",
  "HP Authorised Service Partner",
].join("\n");

/**
 * The draft body.
 *
 * When the call is known it states the live status back — that is the whole point, it saves
 * the coordinator looking it up. When it is not known (or the match is only a guess) it
 * deliberately promises nothing and asks for the WO number instead of inventing a status.
 */
export function draftBody(input: DraftInput): string {
  const hello = `Dear ${greetingName(input.fromName, input.call?.customerName ?? "")},`;
  const signOff = ["Thank you,", "", SIGNATURE].join("\n");

  // A LOW-confidence match is the sender's address matching some call of theirs — it may
  // not be the one they are writing about, so it is never quoted as fact.
  const trustCall = input.call && input.matchConfidence === "HIGH";

  if (!trustCall) {
    return [
      hello,
      "",
      "Thank you for writing to us. We have received your message and our team is looking into it.",
      "",
      "So that we can pull up the right record quickly, could you please confirm the work order number (it looks like WO-0350xxxxx) or the case ID from your service request?",
      "",
      signOff,
    ].join("\n");
  }

  const call = input.call!;
  const lines = [`Work order : ${call.ticketId}`];
  if (call.product) lines.push(`Product    : ${call.product}`);
  if (call.status) lines.push(`Status     : ${call.status}`);
  if (call.engineer) lines.push(`Engineer   : ${call.engineer}`);

  return [
    hello,
    "",
    `Thank you for writing to us about ${call.ticketId}. Here is where your call currently stands:`,
    "",
    ...lines,
    "",
    "Our team is working on it and we will update you as soon as there is progress. If you need anything else in the meantime, simply reply to this email.",
    "",
    signOff,
  ].join("\n");
}
