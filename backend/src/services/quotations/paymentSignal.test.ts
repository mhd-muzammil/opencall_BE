import { describe, it, expect } from "vitest";
import { detectPaymentSignal } from "./paymentSignal.js";

const read = (body: string, hasAttachments = false) =>
  detectPaymentSignal({ subject: "", body, hasAttachments });

/**
 * These decide whether a quotation is marked paid with nobody looking, so the cases that
 * matter most are the ones that must NOT fire. Marking an unpaid quotation paid takes it
 * off the follow-up list and the money is never chased; missing a real payment only costs
 * someone a confirming click.
 */
describe("detectPaymentSignal", () => {
  describe("strong enough to act on", () => {
    it("takes a claim backed by a screenshot", () => {
      const signal = read("Payment done. Screenshot attached.", true);
      expect(signal.level).toBe("STRONG");
    });

    it("takes a claim backed by a UTR", () => {
      expect(read("We have paid, UTR: AXIS0012938471").level).toBe("STRONG");
    });

    it("takes a long bare transaction number alongside the claim", () => {
      expect(read("Amount transferred. Ref 402318765512").level).toBe("STRONG");
    });
  });

  describe("worth a human's eye, not an automatic mark", () => {
    it("flags a bare claim with nothing behind it", () => {
      // Easy to send while the transfer is still queued, or about a different invoice.
      expect(read("Payment done").level).toBe("WEAK");
    });

    it("flags a screenshot that says nothing", () => {
      expect(read("Please check", true).level).toBe("WEAK");
    });

    it("flags a reference with no claim", () => {
      expect(read("UTR AXIS0012938471").level).toBe("WEAK");
    });
  });

  describe("must never fire", () => {
    it("ignores a plain reply", () => {
      expect(read("Please proceed with the repair.").level).toBe("NONE");
    });

    it("ignores a customer ASKING how to pay", () => {
      expect(read("How to pay? Please share your UPI id.", true).level).toBe("NONE");
    });

    it("ignores a request for bank details", () => {
      expect(read("Kindly send me the bank details, I will transfer today.").level).toBe("NONE");
    });

    it("reads the DENIAL, not the words inside it", () => {
      // "payment not done" contains both "payment" and "done".
      expect(read("Payment not done yet, will do tomorrow. Ref 402318765512", true).level).toBe("NONE");
    });

    it("ignores 'I have not paid'", () => {
      expect(read("I have not paid, please wait.", true).level).toBe("NONE");
    });

    it("ignores a failed payment even with a reference", () => {
      expect(read("Payment failed, UTR AXIS0012938471", true).level).toBe("NONE");
    });

    it("ignores a mention of UPI with no payment at all", () => {
      expect(read("Do you accept UPI?").level).toBe("NONE");
    });

    it("ignores an empty message", () => {
      expect(read("").level).toBe("NONE");
    });
  });

  it("says why, so the badge can show it and the undo is an informed one", () => {
    const signal = read("Payment done, UTR AXIS0012938471", true);
    expect(signal.level).toBe("STRONG");
    expect(signal.reasons.join(" | ")).toContain("payment is done");
    expect(signal.reasons.join(" | ")).toContain("transaction reference");
    expect(signal.reasons.join(" | ")).toContain("screenshot");
  });

  it("reads the subject as well as the body", () => {
    const signal = detectPaymentSignal({
      subject: "Payment done - WO-035408009",
      body: "UTR AXIS0012938471",
      hasAttachments: false,
    });
    expect(signal.level).toBe("STRONG");
  });
});
