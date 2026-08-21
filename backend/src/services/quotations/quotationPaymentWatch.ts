import {
  listQuotationsAwaitingReply,
  listRepliesForQuotation,
  listReplyImages,
  listUnplacedRepliesFromCustomer,
  recordQuotationReplyState,
} from "../../repositories/quotationWatchRepository.js";
import { detectPaymentSignal, type PaymentSignalLevel } from "./paymentSignal.js";
import { readScreenshotPayment } from "./screenshotPayment.js";
import { isReadableImage, readImageText } from "./screenshotReader.js";

/**
 * Watch for customers answering a quotation, and settle the ones who say they have paid.
 *
 * Runs after the mailbox sweep, on what the sweep has just stored — so "the customer
 * replied" and "the quotation is paid" both appear without anyone opening the inbox, which
 * is the whole point: sending is a decision, chasing is not.
 *
 * Quotations never sent from here are watched too. Those cannot be re-sent — the customer
 * was given one on WhatsApp, or over the counter, or before sending existed here — but they
 * can still write back saying they have paid, and verifying that is the only thing left to
 * do for them.
 *
 * The strongest reply wins, not the latest. A customer commonly answers twice — a question
 * first, then the transfer — and taking the last message would let a "thanks, received" that
 * arrives after the payment overwrite the mail carrying the reference number, which is the
 * one worth keeping as evidence.
 */

const RANK: Record<PaymentSignalLevel, number> = { NONE: 0, WEAK: 1, STRONG: 2 };

export interface WatchResult {
  checked: number;
  repliedNow: number;
  autoPaid: number;
  needsLook: number;
  /** Screenshots actually read, so the log says whether OCR is doing anything at all. */
  screenshotsRead: number;
}

/**
 * Read the pictures on a reply and see whether one of them is a receipt.
 *
 * Reached only when the words were inconclusive, which is the common case: customers who
 * pay usually send the screenshot and write nothing at all, so the picture IS the message.
 *
 * The first image that resolves wins and the rest are left unread — a reply carrying a
 * receipt and three photographs of the unit should cost one OCR run, not four.
 */
async function readScreenshots(input: {
  emailId: string;
  expectedTotal: number;
  quotationNo: string;
}): Promise<{ read: number; payment: ReturnType<typeof readScreenshotPayment> | null }> {
  let images;
  try {
    images = await listReplyImages(input.emailId);
  } catch (error) {
    console.error(`[quotationWatch] could not load images for ${input.quotationNo}:`, error);
    return { read: 0, payment: null };
  }

  let read = 0;
  for (const image of images) {
    if (!isReadableImage(image.mimeType, image.sizeBytes)) continue;
    const text = await readImageText({ content: image.content, mimeType: image.mimeType });
    read += 1;
    if (!text) continue;

    const payment = readScreenshotPayment({
      text,
      expectedTotal: input.expectedTotal > 0 ? input.expectedTotal : null,
    });
    // UNCLEAR means this picture was not a receipt; the next one still might be.
    if (payment.verdict !== "UNCLEAR") return { read, payment };
  }
  return { read, payment: null };
}

export async function runQuotationPaymentWatch(): Promise<WatchResult> {
  const result: WatchResult = {
    checked: 0,
    repliedNow: 0,
    autoPaid: 0,
    needsLook: 0,
    screenshotsRead: 0,
  };

  const awaiting = await listQuotationsAwaitingReply();

  // How many open quotations each customer has, counted once for the whole sweep.
  //
  // This is what makes the sender-only fallback below safe. A customer with one quotation
  // open who writes "paid" can only mean that one; a customer with two means one of them
  // and nothing says which, so settling either would be a coin toss with their money.
  const openPerCustomer = new Map<string, number>();
  for (const q of awaiting) {
    if (!q.customerEmail) continue;
    openPerCustomer.set(q.customerEmail, (openPerCustomer.get(q.customerEmail) ?? 0) + 1);
  }

  for (const quotation of awaiting) {
    result.checked += 1;

    let replies;
    try {
      replies = await listRepliesForQuotation({
        orderNumber: quotation.orderNumber,
        watchFrom: quotation.watchFrom,
      });
    } catch (error) {
      // One quotation's lookup failing must not end the sweep for the rest of them.
      console.error(
        `[quotationWatch] could not read replies for ${quotation.quotationNo}:`,
        error,
      );
      continue;
    }
    // Nothing quoted the work order. Fall back to the sender — but only when this
    // customer has a single quotation open, so "paid" cannot be about a different one.
    if (
      replies.length === 0 &&
      quotation.customerEmail &&
      openPerCustomer.get(quotation.customerEmail) === 1
    ) {
      try {
        replies = await listUnplacedRepliesFromCustomer({
          fromEmail: quotation.customerEmail,
          watchFrom: quotation.watchFrom,
        });
      } catch (error) {
        console.error(
          `[quotationWatch] could not read sender mail for ${quotation.quotationNo}:`,
          error,
        );
      }
    }

    if (replies.length === 0) continue;

    let best: { level: PaymentSignalLevel; reasons: string[]; emailId: string } | null = null;
    for (const reply of replies) {
      const signal = detectPaymentSignal({
        subject: reply.subject,
        body: reply.bodyText,
        hasImage: reply.hasImage,
      });
      if (!best || RANK[signal.level] > RANK[best.level]) {
        best = { level: signal.level, reasons: signal.reasons, emailId: reply.id };
      }
    }
    if (!best) continue;

    // The words were not enough. If a picture came with the best reply, read it — this is
    // the case the OCR exists for, and the only one it is reached in.
    let screenshotNote = "";
    if (best.level !== "STRONG") {
      const withImage = replies.find((reply) => reply.id === best!.emailId && reply.hasImage)
        ?? replies.find((reply) => reply.hasImage);
      if (withImage) {
        const { read, payment } = await readScreenshots({
          emailId: withImage.id,
          expectedTotal: quotation.expectedTotal,
          quotationNo: quotation.quotationNo,
        });
        result.screenshotsRead += read;

        if (payment) {
          screenshotNote = `screenshot: ${payment.reasons.join(" · ")}`;
          if (payment.verdict === "PAID") {
            // The receipt says the full amount went through. That is stronger evidence
            // than any wording, so it settles the quotation on its own.
            best = {
              level: "STRONG",
              reasons: [...best.reasons, screenshotNote],
              emailId: withImage.id,
            };
          } else {
            // PARTIAL and FAILED are the reasons for reading the image rather than
            // trusting it, and neither may settle anything — a half payment marked paid
            // means the balance is never chased.
            best = {
              level: "WEAK",
              reasons: [...best.reasons, screenshotNote],
              emailId: withImage.id,
            };
          }
        }
      }
    }

    const newest = replies[replies.length - 1]!;
    // Evidence points at the message that earned the level. For an ordinary reply there is
    // nothing to evidence, so it points at the newest one — which is the one to read.
    const evidenceEmailId = best.level === "NONE" ? newest.id : best.emailId;

    const wasSilent = quotation.replySeenAt === null;

    try {
      const changed = await recordQuotationReplyState({
        id: quotation.id,
        replySeenAt: newest.receivedAt,
        signal: best.level,
        reasons: best.reasons.join(" · "),
        evidenceEmailId,
        markPaid: best.level === "STRONG",
      });
      // False means someone settled it between the read and the write. Their decision
      // stands; nothing here is worth overwriting it for.
      if (!changed) continue;
    } catch (error) {
      console.error(
        `[quotationWatch] could not record reply state for ${quotation.quotationNo}:`,
        error,
      );
      continue;
    }

    if (wasSilent) result.repliedNow += 1;
    if (best.level === "STRONG") {
      result.autoPaid += 1;
      console.log(
        `[quotationWatch] ${quotation.quotationNo} marked PAID from a customer reply — ${best.reasons.join(" · ")}`,
      );
    } else if (best.level === "WEAK") {
      result.needsLook += 1;
    }
  }

  return result;
}
