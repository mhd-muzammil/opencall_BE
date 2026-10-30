import type { Request, RequestHandler, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middlewares/errorHandler.js";

const mocks = vi.hoisted(() => ({
  findQuotationById: vi.fn(),
  findQuotationWorkLocation: vi.fn(),
  markQuotationSent: vi.fn(),
  listActiveMailboxes: vi.fn(),
  sendComposedEmail: vi.fn(),
  recordActivity: vi.fn(),
}));

// Nothing here reaches a database, a mailbox or an SMTP server: the send path is asked what
// it would put on the wire, and the stand-ins below record it.
vi.mock("../config/database.js", () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock("../repositories/quotationRepository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repositories/quotationRepository.js")>()),
  findQuotationById: mocks.findQuotationById,
  findQuotationWorkLocation: mocks.findQuotationWorkLocation,
  markQuotationSent: mocks.markQuotationSent,
}));
vi.mock("../repositories/inboundEmailRepository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repositories/inboundEmailRepository.js")>()),
  listActiveMailboxes: mocks.listActiveMailboxes,
}));
vi.mock("../services/inboundEmail/composeService.js", () => ({
  sendComposedEmail: mocks.sendComposedEmail,
}));
vi.mock("../services/audit/activityLogger.js", () => ({ recordActivity: mocks.recordActivity }));

import { quotationSendDefaultsController, sendQuotationController } from "./quotationController.js";

const SUPER_ADMIN = {
  currentUser: {
    id: "user-1",
    email: "office@renderways.in",
    username: "office",
    role: "SUPER_ADMIN",
    regionId: null,
    region_id: null,
    mustChangePassword: false,
    accessibleSections: null,
  },
};

const ID = "4f9c2d0e-8a1b-4c3d-9e2f-0a1b2c3d4e5f";

function quotation(kind: "VISIT" | "PART", overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    kind,
    quotationNo: kind === "VISIT" ? "RTPL/26-27/QEV/7" : "RTPL/26-27/QEN/90",
    quotationDate: "2026-10-30",
    caseId: "5166159539",
    orderNumber: "WO-036344461",
    customerName: "Rajiv Kumar",
    customerEmail: "rajiv@example.com",
    lineItems: [{ serviceDescription: "Visit charge", productDescription: "", modelNo: "", serialNo: "", baseAmount: 550 }],
    sgstPercent: 9,
    cgstPercent: 9,
    sentAt: null,
    sendCount: 0,
    ...overrides,
  };
}

/** A PDF as the browser uploads it: what matters is that it is one. */
const PDF = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\nthe sheet\n%%EOF\n", "latin1");
const pdfFile = (buffer = PDF) => ({
  fieldname: "attachments",
  originalname: "whatever-the-browser-called-it.pdf",
  mimetype: "application/pdf",
  buffer,
  size: buffer.length,
});

const MAILBOXES = [
  { regionCode: "CHENNAI", email: "chennai@renderways.in" },
  { regionCode: "HOSUR", email: "hosur@renderways.in" },
  { regionCode: "TRADE", email: "trade@renderways.in" },
];

interface Answer {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error: { code: string; message: string } | undefined;
}

function call(handler: RequestHandler, request: object): Promise<Answer> {
  return new Promise((resolve) => {
    let status = 200;
    const response = {
      status(code: number) {
        status = code;
        return response;
      },
      json(body: { data?: unknown; error?: Answer["error"] }) {
        resolve({ status, data: body.data, error: body.error });
        return response;
      },
    };
    const req = { params: { id: ID }, query: {}, ...request } as unknown as Request;
    const res = response as unknown as Response;
    handler(req, res, (error?: unknown) => errorHandler(error, req, res, () => undefined));
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sentMail(): any {
  expect(mocks.sendComposedEmail).toHaveBeenCalledTimes(1);
  return mocks.sendComposedEmail.mock.calls[0]![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listActiveMailboxes.mockResolvedValue(MAILBOXES);
  mocks.findQuotationWorkLocation.mockResolvedValue("ASPS01511");
  mocks.sendComposedEmail.mockResolvedValue({ id: "out-1" });
  mocks.markQuotationSent.mockImplementation(async ({ id, sentTo }: { id: string; sentTo: string }) => ({
    ...quotation("VISIT"),
    id,
    sentTo,
    sentAt: "2026-10-30T10:00:00Z",
    sendCount: 1,
  }));
});

describe("sending a Visit quotation", () => {
  beforeEach(() => mocks.findQuotationById.mockResolvedValue(quotation("VISIT")));

  it("goes out as the trade desk's mail, with the sheet attached under the case id", async () => {
    const answer = await call(sendQuotationController, {
      ...SUPER_ADMIN,
      body: { regionCode: "TRADE", to: "rajiv@example.com" },
      files: [pdfFile()],
    });

    expect(answer.status).toBe(200);
    const mail = sentMail();
    expect(mail.regionCode).toBe("TRADE");
    expect(mail.to).toBe("rajiv@example.com");
    expect(mail.subject).toBe("WO-036344461-5166159539- Trade");
    expect(mail.body).toContain("Thank you for providing us an opportunity to serve you with case id: 5166159539");
    expect(mail.bodyHtml).toContain('<span style="background:yellow;">5166159539</span>');
    expect(mail.attachments).toEqual([
      { filename: "5166159539.pdf", mimeType: "application/pdf", content: PDF },
    ]);
    expect(mail.inlineImages).toHaveLength(4);
    expect(mail.messageId).toMatch(new RegExp(`^<quotation\\.${ID}\\.\\d+@renderways\\.in>$`));
    expect(mocks.markQuotationSent).toHaveBeenCalledWith({ id: ID, sentTo: "rajiv@example.com", sentBy: "office@renderways.in" });
  });

  it("leaves from the trade desk whatever mailbox the request names", async () => {
    await call(sendQuotationController, {
      ...SUPER_ADMIN,
      body: { regionCode: "CHENNAI" },
      files: [pdfFile()],
    });
    expect(sentMail().regionCode).toBe("TRADE");
  });

  it("copies the desk's two and the customer's branch when the page names no CC", async () => {
    await call(sendQuotationController, {
      ...SUPER_ADMIN,
      body: { regionCode: "TRADE" },
      files: [pdfFile()],
    });
    expect(sentMail().cc).toBe("radhika@renderways.in, dinesh@renderways.in, hosur@renderways.in");
    expect(mocks.findQuotationWorkLocation).toHaveBeenCalledWith(ID);
  });

  it("copies whoever the sender left in the dialog, and does not look the branch up", async () => {
    await call(sendQuotationController, {
      ...SUPER_ADMIN,
      body: { regionCode: "TRADE", cc: "radhika@renderways.in; salem@renderways.in" },
      files: [pdfFile()],
    });
    expect(sentMail().cc).toBe("radhika@renderways.in; salem@renderways.in");
    expect(mocks.findQuotationWorkLocation).not.toHaveBeenCalled();
  });

  it("copies nobody when the sender cleared the CC", async () => {
    await call(sendQuotationController, {
      ...SUPER_ADMIN,
      body: { regionCode: "TRADE", cc: "" },
      files: [pdfFile()],
    });
    expect(sentMail().cc).toBe("");
  });

  it("falls back to Chennai when the branch cannot be told", async () => {
    mocks.findQuotationWorkLocation.mockResolvedValue("");
    await call(sendQuotationController, { ...SUPER_ADMIN, body: { regionCode: "TRADE" }, files: [pdfFile()] });
    expect(sentMail().cc).toBe("radhika@renderways.in, dinesh@renderways.in, chennai@renderways.in");
  });

  it("falls back to Chennai when the branch has no mailbox configured", async () => {
    mocks.findQuotationWorkLocation.mockResolvedValue("ASPS01489"); // Kanchipuram
    await call(sendQuotationController, { ...SUPER_ADMIN, body: { regionCode: "TRADE" }, files: [pdfFile()] });
    expect(sentMail().cc).toBe("radhika@renderways.in, dinesh@renderways.in, chennai@renderways.in");
  });

  it("refuses to send without the sheet, and says how to get it", async () => {
    const answer = await call(sendQuotationController, {
      ...SUPER_ADMIN,
      body: { regionCode: "TRADE", to: "rajiv@example.com" },
    });
    expect(answer.status).toBe(422);
    expect(answer.error?.message).toContain("Reload the page");
    expect(mocks.sendComposedEmail).not.toHaveBeenCalled();
    expect(mocks.markQuotationSent).not.toHaveBeenCalled();
    // Stopped before anything else was looked up.
    expect(mocks.findQuotationWorkLocation).not.toHaveBeenCalled();
  });

  it("does not take a file that is not a PDF for the sheet, whatever it claims to be", async () => {
    const answer = await call(sendQuotationController, {
      ...SUPER_ADMIN,
      body: { regionCode: "TRADE" },
      files: [pdfFile(Buffer.from("<html>not a pdf</html>"))],
    });
    expect(answer.status).toBe(422);
    expect(mocks.sendComposedEmail).not.toHaveBeenCalled();
  });

  it("puts a covering note above the letter", async () => {
    await call(sendQuotationController, {
      ...SUPER_ADMIN,
      body: { regionCode: "TRADE", note: "As discussed on the phone" },
      files: [pdfFile()],
    });
    const mail = sentMail();
    expect(mail.body.startsWith("As discussed on the phone\n\nDear Customer")).toBe(true);
    expect(mail.bodyHtml.indexOf("As discussed on the phone")).toBeLessThan(mail.bodyHtml.indexOf("Dear <b>Customer</b>"));
  });
});

describe("sending a Part quotation", () => {
  beforeEach(() => mocks.findQuotationById.mockResolvedValue(quotation("PART")));

  it("keeps the mail it has always had, whatever else the request carries", async () => {
    await call(sendQuotationController, {
      ...SUPER_ADMIN,
      body: { regionCode: "CHENNAI", cc: "someone@renderways.in" },
      files: [pdfFile()],
    });
    const mail = sentMail();
    expect(mail.regionCode).toBe("CHENNAI");
    expect(mail.subject).toBe("Quotation RTPL/26-27/QEN/90 — WO-036344461");
    expect(mail.cc).toBe("");
    expect(mail.attachments).toEqual([]);
    expect(mail).not.toHaveProperty("inlineImages");
    expect(mail).not.toHaveProperty("messageId");
    expect(mail.body).toContain("Kindly confirm so we may proceed with the repair.");
  });
});

describe("what the Send dialog is shown before sending", () => {
  it("for a Visit quotation: the subject, the CC by branch and the attachment's name", async () => {
    mocks.findQuotationById.mockResolvedValue(quotation("VISIT"));
    const answer = await call(quotationSendDefaultsController, { ...SUPER_ADMIN });
    expect(answer.status).toBe(200);
    expect(answer.data).toEqual({
      kind: "VISIT",
      from: "trade@renderways.in",
      subject: "WO-036344461-5166159539- Trade",
      cc: ["radhika@renderways.in", "dinesh@renderways.in", "hosur@renderways.in"],
      branch: "HOSUR",
      attachmentName: "5166159539.pdf",
    });
  });

  it("for a Part quotation: its subject, and nothing copied or attached", async () => {
    mocks.findQuotationById.mockResolvedValue(quotation("PART"));
    const answer = await call(quotationSendDefaultsController, { ...SUPER_ADMIN });
    expect(answer.data).toEqual({
      kind: "PART",
      from: null,
      subject: "Quotation RTPL/26-27/QEN/90 — WO-036344461",
      cc: [],
      branch: null,
      attachmentName: null,
    });
    expect(mocks.findQuotationWorkLocation).not.toHaveBeenCalled();
  });

  it("says when the trade desk's mailbox is not set up, rather than naming another", async () => {
    mocks.findQuotationById.mockResolvedValue(quotation("VISIT"));
    mocks.listActiveMailboxes.mockResolvedValue(MAILBOXES.filter((box) => box.regionCode !== "TRADE"));
    const answer = await call(quotationSendDefaultsController, { ...SUPER_ADMIN });
    expect(answer.data.from).toBeNull();
  });

  it("says so when the quotation does not exist", async () => {
    mocks.findQuotationById.mockResolvedValue(null);
    const answer = await call(quotationSendDefaultsController, { ...SUPER_ADMIN });
    expect(answer.status).toBe(404);
  });
});
