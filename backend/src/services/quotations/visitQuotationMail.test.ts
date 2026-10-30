import { describe, expect, it } from "vitest";
import {
  VISIT_MAIL_ACCOUNT_NUMBER,
  visitQuotationAttachmentName,
  visitQuotationCc,
  visitQuotationInlineImages,
  visitQuotationMailHtml,
  visitQuotationMailText,
  visitQuotationSubject,
} from "./visitQuotationMail.js";

/** The desk's own mail this copies: WO-036344461, case 5166159539. */
const SAMPLE = { orderNumber: "WO-036344461", caseId: "5166159539", quotationNo: "RTPL/26-27/QEV/7" };

describe("the Visit quotation mail's subject", () => {
  it("is the work order, the case id and '- Trade', as the desk types it", () => {
    expect(visitQuotationSubject(SAMPLE)).toBe("WO-036344461-5166159539- Trade");
  });

  it("skips a missing part rather than leaving a double dash", () => {
    expect(visitQuotationSubject({ ...SAMPLE, caseId: "" })).toBe("WO-036344461- Trade");
    expect(visitQuotationSubject({ ...SAMPLE, orderNumber: " " })).toBe("5166159539- Trade");
  });

  it("falls back to the quotation's own number when it has neither", () => {
    expect(visitQuotationSubject({ ...SAMPLE, orderNumber: "", caseId: "" })).toBe("RTPL/26-27/QEV/7- Trade");
  });
});

describe("the attached estimate's name", () => {
  it("is the case id, as the desk names it", () => {
    expect(visitQuotationAttachmentName(SAMPLE)).toBe("5166159539.pdf");
  });

  it("falls back to the work order, then the quotation number, made safe for a file name", () => {
    expect(visitQuotationAttachmentName({ ...SAMPLE, caseId: "" })).toBe("WO-036344461.pdf");
    expect(visitQuotationAttachmentName({ ...SAMPLE, caseId: "", orderNumber: "" })).toBe("RTPL_26-27_QEV_7.pdf");
  });
});

describe("who the Visit mail is copied to", () => {
  it("is the desk's two and then the branch's mailbox", () => {
    expect(visitQuotationCc("hosur@renderways.in")).toEqual([
      "radhika@renderways.in",
      "dinesh@renderways.in",
      "hosur@renderways.in",
    ]);
  });

  it("is just the desk's two when there is no branch mailbox", () => {
    expect(visitQuotationCc(null)).toEqual(["radhika@renderways.in", "dinesh@renderways.in"]);
    expect(visitQuotationCc("  ")).toEqual(["radhika@renderways.in", "dinesh@renderways.in"]);
  });

  it("never copies the same address twice", () => {
    expect(visitQuotationCc("Dinesh@renderways.in")).toEqual(["radhika@renderways.in", "dinesh@renderways.in"]);
  });
});

describe("the Visit mail's body", () => {
  const html = visitQuotationMailHtml(SAMPLE);
  const text = visitQuotationMailText(SAMPLE);

  it("carries the desk's letter, word for word, in order", () => {
    const lines = [
      "Dear Customer",
      "Greetings of the day!!",
      "Thank you for providing us an opportunity to serve you with case id: 5166159539",
      "This Quotation is only for service.",
      "Kindly make the payment as per attached estimate",
      "Bank Details: -",
      "Account Name: Renderways Technology Pvt Ltd",
      "Bank Name: BANK OF BARODA",
      `Account Number: ${VISIT_MAIL_ACCOUNT_NUMBER}`,
      "IFSC Code: BARB0MADTHI",
      "Branch: Maduravoyal",
      "Terms and Conditions: -",
      "1.\tIf you have the GST NO of your entity, please share the same along with the payment confirmation",
      "2.\tValidity of quotation: 5 days",
      "3.\tPayment Term: Advance",
      "4.\tPlease do the online transaction, no Cash transaction is accepted.",
      "Contact or email us at: chennai@renderways.in from Monday to Saturday between 9AM TO 6PM.",
      "Best Regards,",
      "Swetha. V",
      "+91 95430 95480  | +91 81898 80681",
      "radhika@renderways.in | www.renderways.in",
      "HP Authorized Service center",
      "Working Hours: 9AM to 7PM",
    ];
    let from = 0;
    for (const line of lines) {
      const at = text.indexOf(line, from);
      expect(at, line).toBeGreaterThanOrEqual(from);
      from = at + line.length;
    }
  });

  it("does not put the amount in the mail: it is in the attached estimate", () => {
    expect(text).not.toMatch(/₹|Rs\.?\s*\d|Total/);
  });

  it("marks the case id in yellow and 'Customer' in bold, as the desk's mail does", () => {
    expect(html).toContain('<span style="background:yellow;">5166159539</span>');
    expect(html).toContain("Dear <b>Customer</b>");
  });

  it("thanks the customer for the work order when there is no case id", () => {
    expect(visitQuotationMailText({ ...SAMPLE, caseId: "" })).toContain("serve you with case id: WO-036344461");
  });

  it("escapes what it interpolates", () => {
    const hostile = visitQuotationMailHtml({ orderNumber: "WO-1", caseId: '<img src=x onerror="alert(1)">' });
    expect(hostile).not.toContain("<img src=x");
    expect(hostile).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("shows exactly the pictures it carries, each by its content id", () => {
    const images = visitQuotationInlineImages();
    const referenced = [...html.matchAll(/src="cid:([^"]+)"/g)].map((m) => m[1]).sort();
    expect(referenced).toEqual(images.map((image) => image.cid).sort());
    for (const image of images) {
      expect(image.contentType).toBe("image/png");
      // PNG signature: the base64 decoded to a real picture, not an empty buffer.
      expect(image.content.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    }
  });
});
