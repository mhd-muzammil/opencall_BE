import type { Quotation } from "../../repositories/quotationRepository.js";
import {
  HP_LOGO_PNG,
  MAIL_ICON_PNG,
  PHONE_ICON_PNG,
  RENDERWAYS_MARK_PNG,
} from "./visitQuotationMailAssets.js";

/**
 * The Visit quotation mail, as the trade desk has always sent it.
 *
 * Copied line by line from the desk's own mail for WO-036344461 (trade@renderways.in,
 * 24 Oct 2026): the same words in the same order, the case id on yellow, the bank details,
 * the four terms and the signature. Its slips are kept as well — "we here by enclosed",
 * "share your approval the payment details" — because this is the mail customers already
 * know, not a rewrite of it.
 *
 * The amount is NOT in the body, and never was: "Kindly make the payment as per attached
 * estimate". The estimate is the Visit sheet itself, attached as a PDF that the sender's
 * browser makes from the very component View / Print shows.
 *
 * Sizes are the sample's, read off a screenshot taken at 125%: Calibri 11pt for the letter,
 * Bookman Old Style 11pt in Office's dark blue for the signature, Cambria bold for the
 * company name and Times New Roman for the address. Line height is left to the mail client,
 * as the original leaves it.
 *
 * The Part quotation keeps its own mail (quotationMailer.ts) until its format is given.
 */

/**
 * The company's Bank of Baroda account, printed in the mail for the customer to pay into.
 * Exported for the payment watch: a reply quoting this mail carries it, and it is not the
 * customer's transaction reference.
 */
export const VISIT_MAIL_ACCOUNT_NUMBER = "43770200000450";

/**
 * The mailbox every Visit quotation leaves from: the trade desk's, trade@renderways.in,
 * whichever branch the customer is in (the user's rule, 30 Oct 2026). Only the CC follows
 * the branch.
 */
export const VISIT_MAIL_FROM_MAILBOX = "TRADE";

/** Always copied, whichever branch the customer is in: the desk's own two. */
export const VISIT_MAIL_FIXED_CC = ["radhika@renderways.in", "dinesh@renderways.in"] as const;

/**
 * The branch mailbox when the customer's branch cannot be told — no work order, or a
 * location no branch claims. Chennai, as on the sample: it is the head office.
 */
export const VISIT_MAIL_FALLBACK_BRANCH = "CHENNAI";

/**
 * Every CC: the desk's two, then the branch's mailbox (visitQuotationRecipients.ts finds
 * it). With no branch mailbox at all, just the two.
 */
export function visitQuotationCc(branchMailbox: string | null | undefined): string[] {
  const all = [...VISIT_MAIL_FIXED_CC, String(branchMailbox ?? "").trim()].filter(Boolean);
  return all.filter(
    (address, index) =>
      all.findIndex((other) => other.toLowerCase() === address.toLowerCase()) === index,
  );
}

/**
 * "WO-036344461-5166159539- Trade": the work order, the case id, then "- Trade", exactly as
 * the desk types it. Whichever of the two is missing is skipped rather than left as "--".
 */
export function visitQuotationSubject(q: Pick<Quotation, "orderNumber" | "caseId" | "quotationNo">): string {
  const ref = [q.orderNumber.trim(), q.caseId.trim()].filter(Boolean).join("-");
  return `${ref || q.quotationNo}- Trade`;
}

/**
 * The attached estimate's file name. The desk names it by the case id (5166159539.pdf); a
 * quotation without one falls back to its work order, then to its own number.
 */
export function visitQuotationAttachmentName(
  q: Pick<Quotation, "orderNumber" | "caseId" | "quotationNo">,
): string {
  const base = q.caseId.trim() || q.orderNumber.trim() || q.quotationNo.trim() || "quotation";
  return `${base.replace(/[^A-Za-z0-9-]+/g, "_")}.pdf`;
}

/** The number the letter thanks the customer for: the case id, or the WO when there is none. */
function caseRef(q: Pick<Quotation, "orderNumber" | "caseId">): string {
  return q.caseId.trim() || q.orderNumber.trim();
}

/**
 * Escape before interpolation, every time. The case id and work order are typed or
 * imported text; a stray `<` would break the layout and a deliberate one would put
 * someone else's markup into mail sent under our address.
 */
function esc(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Content ids of the signature pictures, referenced as cid: from the HTML. */
const CID = {
  mark: "visit-renderways-mark@opencall",
  hp: "visit-hp-logo@opencall",
  phone: "visit-phone-icon@opencall",
  mail: "visit-mail-icon@opencall",
} as const;

/**
 * The signature's pictures, ready for nodemailer: inline parts of the mail, shown in place
 * by their cid. Not stored with the send record — they are the same on every mail.
 */
export function visitQuotationInlineImages(): Array<{
  cid: string;
  filename: string;
  contentType: string;
  content: Buffer;
}> {
  const png = (cid: string, filename: string, base64: string) => ({
    cid,
    filename,
    contentType: "image/png",
    content: Buffer.from(base64, "base64"),
  });
  return [
    png(CID.phone, "phone.png", PHONE_ICON_PNG),
    png(CID.mail, "mail.png", MAIL_ICON_PNG),
    png(CID.mark, "renderways.png", RENDERWAYS_MARK_PNG),
    png(CID.hp, "hp.png", HP_LOGO_PNG),
  ];
}

const LETTER = "font-family:Calibri,Carlito,Arial,sans-serif;font-size:11pt;";
const SIGNATURE =
  "font-family:'Bookman Old Style',Bookman,'URW Bookman',Georgia,serif;font-size:11pt;color:#002060;";
const ADDRESS = "font-family:'Times New Roman',Times,serif;font-size:11pt;";
const LINK = "color:#0563C1;text-decoration:underline;";

/** One line of the mail. Margins zeroed, as the original's paragraphs are. */
function line(content: string, style = ""): string {
  return `<p style="margin:0;${style}">${content}</p>`;
}

/** An empty line between paragraphs, the way the desk's mail spaces them. */
const BLANK = line("&nbsp;");

function mailto(address: string, style = LINK): string {
  return `<a href="mailto:${address}" style="${style}">${address}</a>`;
}

/** The terms, numbered with the text hung off a tab stop, as Outlook laid them out. */
const TERMS = [
  "If you have the GST NO of your entity, please share the same along with the payment confirmation",
  "Validity of quotation: 5 days",
  "Payment Term: Advance",
  "Please do the online transaction, no Cash transaction is accepted.",
];

export function visitQuotationMailHtml(q: Pick<Quotation, "orderNumber" | "caseId">): string {
  const terms = TERMS.map(
    (text, index) =>
      `<tr><td style="${LETTER}padding:0;width:48px;vertical-align:top;">${index + 1}.</td>` +
      `<td style="${LETTER}padding:0;vertical-align:top;">${text}</td></tr>`,
  ).join("");

  const letter = [
    line("Dear <b>Customer</b>"),
    BLANK,
    line("Greetings of the day!!"),
    BLANK,
    line(
      "Thank you for providing us an opportunity to serve you with case id: " +
        `<span style="background:yellow;">${esc(caseRef(q))}</span>`,
    ),
    BLANK,
    line(
      "You have registered the case for providing the services support of the product. " +
        "As you know, since your product / service is not covered under the warranty we here " +
        "by enclosed the quotation for the same. This Quotation is only for service.",
    ),
    BLANK,
    line(
      "Note: Kindly make the payment as per attached estimate, to the given below bank " +
        "details and please share your approval the payment details on mail to " +
        `${mailto("trade@renderways.in")} Based on your confirmation we shall be assigning the engineer.`,
    ),
    BLANK,
    line("<b>Bank Details</b>: -"),
    BLANK,
    line("Account Name: Renderways Technology Pvt Ltd"),
    line("Bank Name: BANK OF BARODA"),
    line(`Account Number: ${VISIT_MAIL_ACCOUNT_NUMBER}`),
    line("IFSC Code: BARB0MADTHI"),
    line("Branch: Maduravoyal"),
    BLANK,
    line("<b>Terms and Conditions: -</b>"),
    BLANK,
    `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${terms}</table>`,
    BLANK,
    line(
      "Being our valued customer, we are committed to provide you the best-in-class support " +
        "experience, thank you for providing us an opportunity to serve you.",
    ),
    BLANK,
    line(
      "If you find any discrepancy with the information shared above, request you to please " +
        "call, will be happy to assist you.",
    ),
    BLANK,
    line(
      `Contact or email us at: ${mailto("chennai@renderways.in")} from Monday to Saturday ` +
        "between 9AM TO 6PM. alternately you can contact us on 9008180476/ 9543095480/8189880681",
    ),
    BLANK,
    BLANK,
    BLANK,
  ].join("\n");

  const icon = (cid: string, width: number, height: number) =>
    `<img src="cid:${cid}" width="${width}" height="${height}" alt="" ` +
    `style="width:${width}px;height:${height}px;vertical-align:middle;border:0;">`;

  const signature = [
    line("Best Regards,", SIGNATURE),
    line("Swetha. V", SIGNATURE),
    line(
      `${icon(CID.phone, 16, 16)}&nbsp; +91 95430 95480&nbsp; | +91 81898 80681`,
      SIGNATURE,
    ),
    line(
      `${icon(CID.mail, 16, 12)}&nbsp; <a href="mailto:radhika@renderways.in" style="${LINK}">radhika@renderways.in</a>` +
        ` | <a href="https://www.renderways.in" style="${LINK}">www.renderways.in</a>`,
      SIGNATURE,
    ),
    BLANK,
    line(
      `<img src="cid:${CID.mark}" width="42" height="35" alt="Renderways" ` +
        `style="width:42px;height:35px;vertical-align:middle;border:0;">&nbsp;&nbsp;` +
        `<b style="font-family:Cambria,Georgia,serif;font-size:11pt;">` +
        `<span style="color:#002060;">Renderways</span> ` +
        `<span style="color:#FF0066;">Technology</span> ` +
        `<span style="color:#002060;">Pvt Ltd</span></b>`,
    ),
    line("HP Authorized Service center", ADDRESS),
    line("&nbsp;", ADDRESS),
    line("<b>Address:</b>", ADDRESS),
    line("#25, 1<sup>st</sup> Floor, Gandhi Street,", ADDRESS),
    line("Mettukuppam, Maduravoyal,", ADDRESS),
    line("Chennai- 600095", ADDRESS),
    line("Working Hours: 9AM to 7PM", ADDRESS),
    line(
      `<img src="cid:${CID.hp}" width="62" height="62" alt="HP" ` +
        `style="width:62px;height:62px;border:0;">`,
    ),
  ].join("\n");

  return `<div style="${LETTER}">\n${letter}\n${signature}\n</div>`;
}

/**
 * The same mail as plain text: the preview line, a text-only client, and the copy the send
 * record keeps. Every word of the HTML, none of the pictures.
 */
export function visitQuotationMailText(q: Pick<Quotation, "orderNumber" | "caseId">): string {
  return [
    "Dear Customer",
    "",
    "Greetings of the day!!",
    "",
    `Thank you for providing us an opportunity to serve you with case id: ${caseRef(q)}`,
    "",
    "You have registered the case for providing the services support of the product. As you know, since your product / service is not covered under the warranty we here by enclosed the quotation for the same. This Quotation is only for service.",
    "",
    "Note: Kindly make the payment as per attached estimate, to the given below bank details and please share your approval the payment details on mail to trade@renderways.in Based on your confirmation we shall be assigning the engineer.",
    "",
    "Bank Details: -",
    "",
    "Account Name: Renderways Technology Pvt Ltd",
    "Bank Name: BANK OF BARODA",
    `Account Number: ${VISIT_MAIL_ACCOUNT_NUMBER}`,
    "IFSC Code: BARB0MADTHI",
    "Branch: Maduravoyal",
    "",
    "Terms and Conditions: -",
    "",
    ...TERMS.map((text, index) => `${index + 1}.\t${text}`),
    "",
    "Being our valued customer, we are committed to provide you the best-in-class support experience, thank you for providing us an opportunity to serve you.",
    "",
    "If you find any discrepancy with the information shared above, request you to please call, will be happy to assist you.",
    "",
    "Contact or email us at: chennai@renderways.in from Monday to Saturday between 9AM TO 6PM. alternately you can contact us on 9008180476/ 9543095480/8189880681",
    "",
    "",
    "",
    "Best Regards,",
    "Swetha. V",
    "+91 95430 95480  | +91 81898 80681",
    "radhika@renderways.in | www.renderways.in",
    "",
    "Renderways Technology Pvt Ltd",
    "HP Authorized Service center",
    "",
    "Address:",
    "#25, 1st Floor, Gandhi Street,",
    "Mettukuppam, Maduravoyal,",
    "Chennai- 600095",
    "Working Hours: 9AM to 7PM",
  ].join("\n");
}
