import { describe, it, expect } from "vitest";
import { readScreenshotPayment } from "./screenshotPayment.js";

const read = (text: string, expectedTotal: number | null = 5900) =>
  readScreenshotPayment({ text, expectedTotal });

/**
 * These run on OCR output, which is dirty by nature — rupee signs come out as R or Z or
 * nothing, and digits swap with letters. The cases that matter most are a part payment
 * being called paid, and a failed transfer being called paid; both take the balance off
 * the follow-up list and neither is recoverable by noticing later.
 */
describe("readScreenshotPayment", () => {
  describe("a real payment", () => {
    it("reads a GPay receipt", () => {
      const result = read("₹5,900\nPayment successful\nUPI transaction ID 402318765512");
      expect(result.verdict).toBe("PAID");
      expect(result.amount).toBe(5900);
      expect(result.reference).toBe("402318765512");
    });

    it("reads a PhonePe receipt with the rupee sign mangled", () => {
      // OCR routinely turns ₹ into R, Z, or drops it entirely.
      expect(read("Rs 5,900.00\nTransaction Successful\nUTR AXIS0012938471").verdict).toBe("PAID");
    });

    it("accepts a few rupees short — rounding and bank charges are not underpayment", () => {
      expect(read("₹5,897 Payment successful UTR AXIS0012938471").verdict).toBe("PAID");
    });

    it("accepts more than quoted", () => {
      expect(read("₹6,000 Payment successful UTR AXIS0012938471").verdict).toBe("PAID");
    });
  });

  describe("the ones that cost money to get wrong", () => {
    it("calls a HALF payment partial, not paid", () => {
      const result = read("₹2,000\nPayment successful\nUTR AXIS0012938471");
      expect(result.verdict).toBe("PARTIAL");
      expect(result.amount).toBe(2000);
      expect(result.reasons.join(" ")).toContain("less than");
    });

    it("calls a FAILED transfer failed, however much it is for", () => {
      expect(read("₹5,900\nPayment failed\nUTR AXIS0012938471").verdict).toBe("FAILED");
    });

    it("calls a PENDING transfer failed rather than paid", () => {
      expect(read("₹5,900 Payment pending UTR AXIS0012938471").verdict).toBe("FAILED");
    });

    it("does not read a transaction id as the amount", () => {
      // A bare 12-digit reference must never become a payment of eleven crore.
      const result = read("Payment successful\nUPI transaction ID 402318765512", 5900);
      expect(result.amount).not.toBe(402318765512);
    });
  });

  describe("not enough to act on", () => {
    it("is unclear when OCR read nothing", () => {
      expect(read("").verdict).toBe("UNCLEAR");
    });

    it("is unclear for a picture that is not a receipt", () => {
      expect(read("IMG_20260821 photo of laptop screen").verdict).toBe("UNCLEAR");
    });

    it("is unclear when there is an amount but no sign it went through", () => {
      expect(read("₹5,900").verdict).toBe("UNCLEAR");
    });

    it("still resolves with no quotation total, given a clear receipt", () => {
      expect(read("Payment successful UTR AXIS0012938471", null).verdict).toBe("PAID");
    });

    it("is unclear with no total and no transaction id", () => {
      expect(read("Payment successful", null).verdict).toBe("UNCLEAR");
    });
  });

  it("says what it saw, so a person can check the machine's working", () => {
    const result = read("₹5,900 Payment successful UTR AXIS0012938471");
    const said = result.reasons.join(" | ");
    expect(said).toContain("5,900");
    expect(said).toContain("successful");
    expect(said).toContain("AXIS0012938471");
  });
});
