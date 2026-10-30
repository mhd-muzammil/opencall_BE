import { describe, expect, it } from "vitest";
import {
  DESK_MAIL_ACCOUNT_NUMBER,
  deskMailAttachmentName,
  deskMailCc,
  deskMailHtml,
  deskMailInlineImages,
  deskMailSubject,
  deskMailText,
} from "./tradeDeskMail.js";

/** The desk's own Visit mail this copies: WO-036344461, case 5166159539. */
const VISIT = {
  kind: "VISIT" as const,
  orderNumber: "WO-036344461",
  caseId: "5166159539",
  quotationNo: "RTPL/26-27/QEV/7",
  serialNo: "",
  lineItems: [],
};

/** The desk's own Part mail: serial 5CD41226PO, as the sheet's first line item carries it. */
const item = { serviceDescription: "", productDescription: "Keyboard", modelNo: "", serialNo: "5CD41226PO", baseAmount: 1200 };
const PART = {
  kind: "PART" as const,
  orderNumber: "WO-036400001",
  caseId: "5166200001",
  quotationNo: "RTPL/26-27/QEN/80",
  serialNo: "5CD41226PO",
  lineItems: [item],
};

describe("the subject", () => {
  it("is the work order, the case id and '- Trade' for a Visit, as the desk types it", () => {
    expect(deskMailSubject(VISIT)).toBe("WO-036344461-5166159539- Trade");
  });

  it("skips a missing part of a Visit subject rather than leaving a double dash", () => {
    expect(deskMailSubject({ ...VISIT, caseId: "" })).toBe("WO-036344461- Trade");
    expect(deskMailSubject({ ...VISIT, orderNumber: " " })).toBe("5166159539- Trade");
    expect(deskMailSubject({ ...VISIT, orderNumber: "", caseId: "" })).toBe("RTPL/26-27/QEV/7- Trade");
  });

  it("is 'Serial No- … - Righter with HP - Part Quote' for a Part, as the desk types it", () => {
    expect(deskMailSubject(PART)).toBe("Serial No- 5CD41226PO- Righter with HP - Part Quote");
  });

  it("takes a Part's serial from the first line item that has one", () => {
    const second = { ...item, serialNo: "CND9999XYZ" };
    expect(deskMailSubject({ ...PART, serialNo: "", lineItems: [{ ...item, serialNo: " " }, second] })).toBe(
      "Serial No- CND9999XYZ- Righter with HP - Part Quote",
    );
  });

  it("falls back to the work order when a Part has no serial at all", () => {
    expect(deskMailSubject({ ...PART, serialNo: "", lineItems: [{ ...item, serialNo: "" }] })).toBe(
      "Serial No- WO-036400001- Righter with HP - Part Quote",
    );
  });
});

describe("the attached estimate's name", () => {
  it("is the case id for a Visit, as the desk names it", () => {
    expect(deskMailAttachmentName(VISIT)).toBe("5166159539.pdf");
    expect(deskMailAttachmentName({ ...VISIT, caseId: "" })).toBe("WO-036344461.pdf");
    expect(deskMailAttachmentName({ ...VISIT, caseId: "", orderNumber: "" })).toBe("RTPL_26-27_QEV_7.pdf");
  });

  it("is the quotation number for a Part, as the desk's RTPL_26-27_QEN_80.pdf", () => {
    expect(deskMailAttachmentName(PART)).toBe("RTPL_26-27_QEN_80.pdf");
  });
});

describe("who the mail is copied to", () => {
  it("is the desk's two and then the branch's mailbox", () => {
    expect(deskMailCc("hosur@renderways.in")).toEqual([
      "radhika@renderways.in",
      "dinesh@renderways.in",
      "hosur@renderways.in",
    ]);
  });

  it("is just the desk's two when there is no branch mailbox", () => {
    expect(deskMailCc(null)).toEqual(["radhika@renderways.in", "dinesh@renderways.in"]);
    expect(deskMailCc("  ")).toEqual(["radhika@renderways.in", "dinesh@renderways.in"]);
  });

  it("never copies the same address twice", () => {
    expect(deskMailCc("Dinesh@renderways.in")).toEqual(["radhika@renderways.in", "dinesh@renderways.in"]);
  });
});

/** Every line, in order, as the desk's mails have them. */
function inOrder(text: string, lines: string[]) {
  let from = 0;
  for (const wanted of lines) {
    const at = text.indexOf(wanted, from);
    expect(at, wanted).toBeGreaterThanOrEqual(from);
    from = at + wanted.length;
  }
}

const COMMON_TAIL = [
  "Kindly make the payment as per attached estimate",
  "Bank Details: -",
  "Account Name: Renderways Technology Pvt Ltd",
  "Bank Name: BANK OF BARODA",
  `Account Number: ${DESK_MAIL_ACCOUNT_NUMBER}`,
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

describe("the Visit mail's body", () => {
  const html = deskMailHtml(VISIT);
  const text = deskMailText(VISIT);

  it("carries the desk's letter, word for word, in order", () => {
    inOrder(text, [
      "Dear Customer",
      "Greetings of the day!!",
      "Thank you for providing us an opportunity to serve you with case id: 5166159539",
      "This Quotation is only for service.",
      ...COMMON_TAIL,
    ]);
  });

  it("does not put the amount in the mail: it is in the attached estimate", () => {
    expect(text).not.toMatch(/₹|Rs\.?\s*\d|Total/);
  });

  it("marks the case id in yellow and 'Customer' in bold, as the desk's mail does", () => {
    expect(html).toContain('<span style="background:yellow;">5166159539</span>');
    expect(html).toContain("Dear <b>Customer</b>");
  });

  it("thanks the customer for the work order when there is no case id", () => {
    expect(deskMailText({ ...VISIT, caseId: "" })).toContain("serve you with case id: WO-036344461");
  });

  it("escapes what it interpolates", () => {
    const hostile = deskMailHtml({ ...VISIT, caseId: '<img src=x onerror="alert(1)">' });
    expect(hostile).not.toContain("<img src=x");
    expect(hostile).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("shows exactly the pictures it carries, each by its content id", () => {
    const images = deskMailInlineImages();
    const referenced = [...html.matchAll(/src="cid:([^"]+)"/g)].map((m) => m[1]).sort();
    expect(referenced).toEqual(images.map((image) => image.cid).sort());
    for (const image of images) {
      expect(image.contentType).toBe("image/png");
      // PNG signature: the base64 decoded to a real picture, not an empty buffer.
      expect(image.content.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    }
  });
});

describe("the Part mail's body", () => {
  const html = deskMailHtml(PART);
  const text = deskMailText(PART);

  it("carries the desk's Part letter: the serial number, and 'only for Parts'", () => {
    inOrder(text, [
      "Dear Customer",
      "Greetings of the day!!",
      "Thank you for providing us an opportunity to serve you with Serial No: 5CD41226PO",
      "This Quotation is only for Parts.",
      ...COMMON_TAIL,
    ]);
    expect(text).not.toContain("case id");
    expect(text).not.toContain("only for service");
  });

  it("names the serial plainly, without the Visit mail's yellow", () => {
    expect(html).toContain("serve you with Serial No: 5CD41226PO</p>");
    expect(html).not.toContain("background:yellow");
  });

  it("escapes the serial number as well", () => {
    expect(deskMailHtml({ ...PART, lineItems: [{ ...item, serialNo: "<b>x</b>" }] })).toContain("Serial No: &lt;b&gt;x&lt;/b&gt;");
  });

  it("carries the same signature pictures", () => {
    const referenced = [...html.matchAll(/src="cid:([^"]+)"/g)].map((m) => m[1]);
    expect(referenced).toHaveLength(4);
  });
});
