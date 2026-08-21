import {
  listQuotationsAwaitingReply,
  listRepliesForQuotation,
  recordQuotationReplyState,
} from "../../repositories/quotationWatchRepository.js";
import { detectPaymentSignal, type PaymentSignalLevel } from "./paymentSignal.js";

/**
 * Watch for customers answering a quotation, and settle the ones who say they have paid.
 *
 * Runs after the mailbox sweep, on what the sweep has just stored — so "the customer
 * replied" and "the quotation is paid" both appear without anyone opening the inbox, which
 * is the whole point: sending is a decision, chasing is not.
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
}

export async function runQuotationPaymentWatch(): Promise<WatchResult> {
  const result: WatchResult = { checked: 0, repliedNow: 0, autoPaid: 0, needsLook: 0 };

  const awaiting = await listQuotationsAwaitingReply();
  for (const quotation of awaiting) {
    result.checked += 1;

    let replies;
    try {
      replies = await listRepliesForQuotation({
        orderNumber: quotation.orderNumber,
        sentAt: quotation.sentAt,
      });
    } catch (error) {
      // One quotation's lookup failing must not end the sweep for the rest of them.
      console.error(
        `[quotationWatch] could not read replies for ${quotation.quotationNo}:`,
        error,
      );
      continue;
    }
    if (replies.length === 0) continue;

    let best: { level: PaymentSignalLevel; reasons: string[]; emailId: string } | null = null;
    for (const reply of replies) {
      const signal = detectPaymentSignal({
        subject: reply.subject,
        body: reply.bodyText,
        hasAttachments: reply.hasAttachments,
      });
      if (!best || RANK[signal.level] > RANK[best.level]) {
        best = { level: signal.level, reasons: signal.reasons, emailId: reply.id };
      }
    }
    if (!best) continue;

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
