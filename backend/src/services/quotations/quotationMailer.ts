import type { Quotation } from "../../repositories/quotationRepository.js";

/**
 * The quotation as a customer receives it.
 *
 * Built here rather than reusing the on-screen sheet because that one is React and lives in
 * the browser. A mail client is not a browser: no external stylesheet is fetched, no class
 * is resolved, and anything clever is stripped — so this is a plain table with inline
 * styles, which is the shape mail clients have rendered reliably for twenty years.
 *
 * The plain-text version is not a fallback nobody reads. It is what shows in the preview
 * line, what a phone client may render instead, and what the audit copy stores, so it
 * carries the same figures rather than "please view in HTML".
 */

function money(value: number): string {
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Totals, computed here so the mail can never disagree with the sheet it came from. */
function totals(quotation: Quotation): {
  subtotal: number;
  sgst: number;
  cgst: number;
  total: number;
} {
  const subtotal = quotation.lineItems.reduce((sum, item) => sum + item.baseAmount, 0);
  const sgst = (subtotal * quotation.sgstPercent) / 100;
  const cgst = (subtotal * quotation.cgstPercent) / 100;
  return { subtotal, sgst, cgst, total: subtotal + sgst + cgst };
}

/**
 * Escape before interpolation, every time.
 *
 * Customer names, descriptions and part numbers are typed by hand into a form. A stray
 * `<` would break the layout; a deliberate one would put markup of someone else's choosing
 * into mail we send under our own address.
 */
function esc(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function quotationSubject(quotation: Quotation): string {
  const ref = quotation.orderNumber || quotation.caseId;
  return `Quotation ${quotation.quotationNo}${ref ? ` — ${ref}` : ""}`;
}

export function quotationMailText(quotation: Quotation): string {
  const { subtotal, sgst, cgst, total } = totals(quotation);
  const lines = quotation.lineItems.map(
    (item, index) =>
      `${index + 1}. ${item.serviceDescription || item.productDescription || "-"}` +
      `${item.modelNo ? ` (${item.modelNo})` : ""} — Rs ${money(item.baseAmount)}`,
  );

  return [
    `Dear ${quotation.customerName || "Customer"},`,
    "",
    `Please find below our quotation ${quotation.quotationNo} dated ${quotation.quotationDate}.`,
    quotation.orderNumber ? `Work Order: ${quotation.orderNumber}` : "",
    quotation.caseId ? `Case ID: ${quotation.caseId}` : "",
    "",
    ...lines,
    "",
    `Subtotal: Rs ${money(subtotal)}`,
    `SGST (${quotation.sgstPercent}%): Rs ${money(sgst)}`,
    `CGST (${quotation.cgstPercent}%): Rs ${money(cgst)}`,
    `Total: Rs ${money(total)}`,
    "",
    "Kindly confirm so we may proceed with the repair.",
    "",
    "Regards,",
    "Renderways Technology Pvt Ltd",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function quotationMailHtml(quotation: Quotation): string {
  const { subtotal, sgst, cgst, total } = totals(quotation);

  const rows = quotation.lineItems
    .map(
      (item, index) => `
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">${index + 1}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">
            ${esc(item.serviceDescription || item.productDescription || "-")}
            ${item.modelNo ? `<br><span style="color:#6b7280;font-size:12px;">${esc(item.modelNo)}</span>` : ""}
            ${item.serialNo ? `<br><span style="color:#6b7280;font-size:12px;">SN: ${esc(item.serialNo)}</span>` : ""}
          </td>
          <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;">
            ₹${money(item.baseAmount)}
          </td>
        </tr>`,
    )
    .join("");

  const totalRow = (label: string, value: string, bold = false): string => `
    <tr>
      <td colspan="2" style="padding:6px 10px;text-align:right;${bold ? "font-weight:700;" : "color:#4b5563;"}">${label}</td>
      <td style="padding:6px 10px;text-align:right;white-space:nowrap;${bold ? "font-weight:700;font-size:15px;" : "color:#4b5563;"}">${value}</td>
    </tr>`;

  return `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;max-width:640px;">
  <p>Dear ${esc(quotation.customerName || "Customer")},</p>
  <p>Please find below our quotation for the service on your unit.</p>

  <table style="border-collapse:collapse;margin:16px 0;font-size:13px;">
    <tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Quotation No</td><td style="font-weight:700;">${esc(quotation.quotationNo)}</td></tr>
    <tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Date</td><td>${esc(quotation.quotationDate)}</td></tr>
    ${quotation.orderNumber ? `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Work Order</td><td>${esc(quotation.orderNumber)}</td></tr>` : ""}
    ${quotation.caseId ? `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Case ID</td><td>${esc(quotation.caseId)}</td></tr>` : ""}
  </table>

  <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e5e7eb;">
    <thead>
      <tr style="background:#f3f4f6;">
        <th style="padding:8px 10px;text-align:left;border-bottom:1px solid #e5e7eb;">#</th>
        <th style="padding:8px 10px;text-align:left;border-bottom:1px solid #e5e7eb;">Description</th>
        <th style="padding:8px 10px;text-align:right;border-bottom:1px solid #e5e7eb;">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
      ${totalRow("Subtotal", `₹${money(subtotal)}`)}
      ${totalRow(`SGST (${quotation.sgstPercent}%)`, `₹${money(sgst)}`)}
      ${totalRow(`CGST (${quotation.cgstPercent}%)`, `₹${money(cgst)}`)}
      ${totalRow("Total", `₹${money(total)}`, true)}
    </tbody>
  </table>

  <p style="margin-top:18px;">Kindly confirm so we may proceed with the repair.</p>
  <p style="margin-top:18px;color:#6b7280;font-size:13px;">
    Regards,<br>
    <strong style="color:#111827;">Renderways Technology Pvt Ltd</strong>
  </p>
</div>`.trim();
}
