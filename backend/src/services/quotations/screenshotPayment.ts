/**
 * What a payment screenshot says, once its text has been read off it.
 *
 * Separate from the reply's own wording because a screenshot speaks a different language.
 * Customers who send one usually write nothing at all — the picture IS the message — and
 * what it contains is not a sentence but a receipt: an app's success line, an amount, and a
 * transaction id. So this looks for those three things rather than for "we have paid".
 *
 * Deliberately given the quotation's total, and deliberately allowed to answer PARTIAL. A
 * customer paying half is the case that costs the most to get wrong: mark it paid and the
 * balance is never chased, and nothing in the words distinguishes it — only the figure
 * does. That is the whole reason for reading the image rather than counting it as proof.
 *
 * OCR text is dirty by nature. Rupee signs come out as "R", "₹", "Z" or nothing, commas and
 * full stops swap, and "l" and "1" trade places, so every pattern here is written loosely
 * and nothing depends on one character being read correctly.
 */

export type ScreenshotVerdict = "PAID" | "PARTIAL" | "FAILED" | "UNCLEAR";

export interface ScreenshotPayment {
  verdict: ScreenshotVerdict;
  /** The largest amount found, which on a receipt is the one that was transferred. */
  amount: number | null;
  reference: string;
  reasons: string[];
}

/** An app saying the transfer went through. */
const SUCCESS_WORDS =
  /\b(payment\s+success(ful)?|transaction\s+success(ful)?|success(ful)?|paid\s+to|payment\s+done|completed|transfer(red)?\s+success(ful)?|money\s+sent|debited)\b/i;

/** An app saying it did not. Checked first — "payment failed" contains "payment". */
const FAILURE_WORDS =
  /\b(fail(ed|ure)?|declined|cancell?ed|pending|unsuccessful|not\s+processed|reversed|refunded)\b/i;

const REFERENCE = /\b(?:utr|upi\s*(?:transaction\s*)?id|transaction\s*id|txn\s*id|ref(?:erence)?\s*(?:no\.?|id)?)\s*[:#-]?\s*([A-Z0-9]{8,})\b/i;

/**
 * Amounts, loosely.
 *
 * Anchored on a currency marker where there is one, because a receipt is full of numbers
 * that are not the amount — dates, times, phone numbers, the reference itself. Reading a
 * bare number as the sum transferred is how a UTR becomes a payment of eleven crore.
 */
const AMOUNT_PATTERNS: readonly RegExp[] = [
  // ₹5,900.00 — and the several things OCR turns ₹ into.
  /(?:₹|rs\.?|inr|r\s|z\s)\s*([0-9][0-9,\s]{0,12}(?:\.[0-9]{1,2})?)/gi,
  // 5,900.00 with the grouping commas OCR usually keeps.
  /\b([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?)\b/g,
];

function parseAmounts(text: string): number[] {
  const found: number[] = [];
  for (const pattern of AMOUNT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const raw = (match[1] ?? "").replace(/[,\s]/g, "");
      if (!raw) continue;
      const value = Number(raw);
      // Above a crore is not a repair bill; it is a reference number that has been read as
      // a figure. Below a rupee is noise.
      if (Number.isFinite(value) && value >= 1 && value <= 10_000_000) {
        found.push(value);
      }
    }
  }
  return found;
}

/**
 * How far off the quotation an amount may be and still count as paying it.
 *
 * Not zero: rounding, a bank charge, or a digit misread by OCR all move the figure by a
 * little, and refusing those would send every genuine payment to a human. One percent or
 * five rupees, whichever is larger — small enough that half a payment can never pass.
 */
function withinTolerance(paid: number, expected: number): boolean {
  const slack = Math.max(5, expected * 0.01);
  return paid >= expected - slack;
}

export function readScreenshotPayment(input: {
  /** Whatever OCR made of the image. Expected to be messy. */
  text: string;
  /** The quotation's total, so a part payment can be told from a full one. */
  expectedTotal: number | null;
}): ScreenshotPayment {
  const text = (input.text ?? "").trim();
  if (!text) {
    return { verdict: "UNCLEAR", amount: null, reference: "", reasons: [] };
  }

  const reasons: string[] = [];

  // Before anything else. A failed or pending transfer is not a payment, and the word
  // "payment" appears in both.
  if (FAILURE_WORDS.test(text) && !/\bsuccess/i.test(text)) {
    return {
      verdict: "FAILED",
      amount: null,
      reference: "",
      reasons: ["the screenshot shows a failed or pending transfer"],
    };
  }

  const referenceMatch = REFERENCE.exec(text);
  const reference = referenceMatch?.[1] ?? "";
  if (reference) reasons.push(`transaction id ${reference}`);

  const amounts = parseAmounts(text);
  // The largest: a receipt shows the transferred sum alongside smaller things — a balance
  // line, a fee, the last digits of an account.
  const amount = amounts.length > 0 ? Math.max(...amounts) : null;
  if (amount !== null) reasons.push(`shows ₹${amount.toLocaleString("en-IN")}`);

  const succeeded = SUCCESS_WORDS.test(text);
  if (succeeded) reasons.push("the app reports it as successful");

  // Nothing to go on. Better said plainly than guessed at.
  if (!succeeded && !reference && amount === null) {
    return { verdict: "UNCLEAR", amount: null, reference: "", reasons: [] };
  }

  // The figure is the only thing that distinguishes a part payment, so when both it and the
  // quotation's total are known, it decides.
  if (amount !== null && input.expectedTotal !== null && input.expectedTotal > 0) {
    if (withinTolerance(amount, input.expectedTotal)) {
      return succeeded || reference
        ? { verdict: "PAID", amount, reference, reasons }
        : { verdict: "UNCLEAR", amount, reference, reasons };
    }
    reasons.push(
      `less than the ₹${input.expectedTotal.toLocaleString("en-IN")} quoted`,
    );
    return { verdict: "PARTIAL", amount, reference, reasons };
  }

  // No total to check against — the quotation's own figure is missing, or OCR found no
  // amount. A clear success line plus a transaction id is still a receipt.
  if (succeeded && reference) {
    return { verdict: "PAID", amount, reference, reasons };
  }

  return { verdict: "UNCLEAR", amount, reference, reasons };
}
