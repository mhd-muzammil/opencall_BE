/**
 * Reading "the customer has paid" out of a reply.
 *
 * This decides whether a quotation is marked paid without anyone looking, so the bar is set
 * where a false positive is unlikely rather than where a true one is always caught. Marking
 * an unpaid quotation paid takes it off the follow-up list and the money is never chased;
 * missing a real payment only means someone confirms it by hand, which is what happened
 * before this existed. The two errors are not equal and the thresholds are not symmetric.
 *
 * Three answers, not two:
 *   STRONG — say so plainly AND back it with a reference number or a screenshot. Auto-marked.
 *   WEAK   — something payment-shaped, not enough to act on. Flagged for a human.
 *   NONE   — an ordinary reply.
 *
 * Deliberately NOT read: the amount. Customers pay in parts, pay the wrong figure, and send
 * screenshots of an unrelated transfer, and no amount of parsing tells the difference
 * between "paid ₹5,900" and "paid ₹590 of ₹5,900". The figure stays a human's problem.
 */

export type PaymentSignalLevel = "STRONG" | "WEAK" | "NONE";

export interface PaymentSignal {
  level: PaymentSignalLevel;
  /** Why, in words, for the badge on the quotation and the undo decision behind it. */
  reasons: string[];
}

/**
 * "We have paid" said outright. Anchored on the payment word itself rather than on the
 * rails ("UPI", "NEFT") — a customer asking *how* to pay by UPI is not a payment.
 */
const PAID_PHRASES: readonly RegExp[] = [
  /\bpayment\s+(is\s+)?(done|completed|made|success(ful)?)\b/i,
  /\b(amount|money|payment)\s+(has\s+been\s+)?(transferred|credited|sent|paid)\b/i,
  /\b(i|we)\s+(have\s+)?(already\s+)?(paid|transferred|remitted)\b/i,
  /\bpaid\s+(the\s+)?(amount|bill|invoice|quotation|full|total)\b/i,
  /\b(payment|amount)\s+done\b/i,
  /\bhas\s+been\s+paid\b/i,
];

/** The rails a payment runs on. Corroborating on their own, never conclusive. */
const RAIL_WORDS = /\b(upi|neft|imps|rtgs|gpay|g\s?pay|phonepe|paytm|netbanking|net\s?banking|bank\s+transfer)\b/i;

/**
 * A transaction reference. Banks and UPI apps quote one on every successful transfer, and
 * a customer only has it to quote once the money has actually moved — which is what makes
 * it the strongest corroboration available without reading the screenshot.
 */
const REFERENCE_PATTERNS: readonly RegExp[] = [
  /\b(utr|txn|transaction|ref(erence)?|order)\s*(no\.?|number|id)?\s*[:#-]?\s*([A-Z0-9]{8,})\b/i,
  /\b\d{12,}\b/,
];

/** Said outright that they have NOT paid, or are asking how to. Never a payment. */
const NEGATIONS: readonly RegExp[] = [
  /\b(not|yet\s+to|haven'?t|have\s+not|won'?t|will\s+not|unable\s+to)\s+(be\s+)?(paid|pay|make\s+the\s+payment|transfer)\b/i,
  /\b(how|where|whom)\s+(to|do\s+i|should\s+i|can\s+i)\s+pay\b/i,
  /\bpayment\s+(pending|failed|declined|not\s+done)\b/i,
  /\bshare\s+(your\s+)?(bank|account|upi)\s+(details|id)\b/i,
  /\bsend\s+(me\s+)?(the\s+)?(bank|account|upi)\s+details\b/i,
];

/**
 * The mail's own text, flattened — the ingest already stores it that way, and these rules
 * were written against flattened text rather than markup.
 */
export function detectPaymentSignal(input: {
  subject: string;
  body: string;
  /** A screenshot of a transfer is the commonest proof customers send. */
  hasAttachments: boolean;
}): PaymentSignal {
  const text = `${input.subject ?? ""}\n${input.body ?? ""}`;
  if (!text.trim()) return { level: "NONE", reasons: [] };

  // Checked first and decisive. "Payment not done" contains "payment" and "done"; reading
  // the claim before the denial would turn a chase-me mail into a paid quotation.
  const denial = NEGATIONS.find((pattern) => pattern.test(text));
  if (denial) {
    return { level: "NONE", reasons: ["says the payment has not been made"] };
  }

  const reasons: string[] = [];
  const claimsPaid = PAID_PHRASES.some((pattern) => pattern.test(text));
  if (claimsPaid) reasons.push("says the payment is done");

  const hasReference = REFERENCE_PATTERNS.some((pattern) => pattern.test(text));
  if (hasReference) reasons.push("quotes a transaction reference");

  const mentionsRail = RAIL_WORDS.test(text);
  if (mentionsRail) reasons.push("names a payment method");

  if (input.hasAttachments) reasons.push("attached a file, likely a payment screenshot");

  // Strong needs the claim AND something behind it. A bare "payment done" is the easiest
  // thing in the world to send while a transfer is still queued, or to say about a
  // different invoice entirely.
  if (claimsPaid && (hasReference || input.hasAttachments)) {
    return { level: "STRONG", reasons };
  }

  // Everything else payment-shaped is worth a human's eye and nothing more: a claim with
  // no proof, or proof with no claim.
  //
  // A bare attachment counts, because of where this runs. These are replies to a quotation
  // WE sent asking to be paid, and the commonest thing a customer attaches to one is a
  // screenshot of the transfer. WEAK costs a glance and nothing else, so the cheap answer
  // is to surface it; the expensive answer would be marking it paid, which needs the claim.
  if (claimsPaid || hasReference || input.hasAttachments) {
    return { level: "WEAK", reasons };
  }

  return { level: "NONE", reasons: [] };
}
