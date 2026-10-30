import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findQuotationWorkOrders: vi.fn(),
  findRowByTicketId: vi.fn(),
  findRowByCustomerEmail: vi.fn(),
}));

// No database: the quotations the thread names are looked up through this stand-in.
vi.mock("../../config/database.js", () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock("../../repositories/quotationRepository.js", () => ({
  findQuotationWorkOrders: mocks.findQuotationWorkOrders,
}));
vi.mock("../../repositories/inboundEmailRepository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../repositories/inboundEmailRepository.js")>()),
  findRowByTicketId: mocks.findRowByTicketId,
  findRowByCustomerEmail: mocks.findRowByCustomerEmail,
}));

import { matchInboundMail, workOrdersNamedByQuotationThread } from "./inboundEmailService.js";
import { quotationMessageId } from "../quotations/quotationMessageId.js";

const ID = "4f9c2d0e-8a1b-4c3d-9e2f-0a1b2c3d4e5f";

/**
 * A customer's reply to the trade desk's Part mail names no work order — not in its subject
 * ("Re: Serial No- 5CD41226PO- Righter with HP - Part Quote"), not in the letter it quotes.
 * Its thread headers name the quotation, and the quotation knows the work order.
 */
describe("workOrdersNamedByQuotationThread", () => {
  beforeEach(() => vi.clearAllMocks());

  it("gives the work order of the quotation a reply answers", async () => {
    mocks.findQuotationWorkOrders.mockResolvedValue([{ ticketId: "WO-036344461", caseId: "5166159539" }]);
    const wos = await workOrdersNamedByQuotationThread({
      "in-reply-to": quotationMessageId(ID),
      references: quotationMessageId(ID),
    });
    expect(wos).toEqual([{ ticketId: "WO-036344461", caseId: "5166159539" }]);
    expect(mocks.findQuotationWorkOrders).toHaveBeenCalledWith([ID]);
  });

  it("asks nothing of the database for an ordinary mail", async () => {
    expect(await workOrdersNamedByQuotationThread({ "in-reply-to": "<CAF+abc@mail.gmail.com>" })).toEqual([]);
    expect(mocks.findQuotationWorkOrders).not.toHaveBeenCalled();
  });

  it("never costs a mail its place in the inbox when the lookup fails", async () => {
    mocks.findQuotationWorkOrders.mockRejectedValue(new Error("connection reset"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await workOrdersNamedByQuotationThread({ "in-reply-to": quotationMessageId(ID) })).toEqual([]);
    warn.mockRestore();
  });
});

describe("matchInboundMail", () => {
  const reply = {
    headers: { "in-reply-to": quotationMessageId(ID) },
    subject: "Re: Serial No- 5CD41226PO- Righter with HP - Part Quote",
    preview: "Payment done, UTR 412345678901",
    fromEmail: "rajiv@example.com",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findQuotationWorkOrders.mockResolvedValue([{ ticketId: "WO-036344461", caseId: "5166159539" }]);
    // The customer's newest row is a different job: the trap the thread avoids.
    mocks.findRowByCustomerEmail.mockResolvedValue({ ticketId: "WO-036500000", caseId: "5166300000" });
  });

  it("places a reply on the quotation's job, from the report when it is there", async () => {
    mocks.findRowByTicketId.mockResolvedValue({ ticketId: "WO-036344461", caseId: "5166159539", customerMail: "" });
    expect(await matchInboundMail(reply)).toEqual({
      ticketId: "WO-036344461",
      caseId: "5166159539",
      method: "WO_NUMBER",
      confidence: "HIGH",
    });
    expect(mocks.findRowByCustomerEmail).not.toHaveBeenCalled();
  });

  it("keeps the quotation's job even after it has left the report, never the sender's newest", async () => {
    mocks.findRowByTicketId.mockResolvedValue(null);
    expect(await matchInboundMail(reply)).toMatchObject({ ticketId: "WO-036344461", confidence: "HIGH" });
    expect(mocks.findRowByCustomerEmail).not.toHaveBeenCalled();
  });

  it("matches an ordinary mail as before: a WO on the report, else the sender", async () => {
    mocks.findQuotationWorkOrders.mockResolvedValue([]);
    mocks.findRowByTicketId.mockImplementation(async (wo: string) =>
      wo === "WO-036100000" ? { ticketId: wo, caseId: "5166100000", customerMail: "" } : null,
    );
    expect(
      await matchInboundMail({ headers: {}, subject: "About WO-036100000", preview: "", fromEmail: "a@example.com" }),
    ).toMatchObject({ ticketId: "WO-036100000", method: "WO_NUMBER", confidence: "HIGH" });
    expect(
      await matchInboundMail({ headers: {}, subject: "Hello", preview: "", fromEmail: "a@example.com" }),
    ).toMatchObject({ ticketId: "WO-036500000", method: "CUSTOMER_EMAIL", confidence: "LOW" });
  });
});
