import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendMail: vi.fn(),
  listActiveMailboxes: vi.fn(),
  createOutboundEmail: vi.fn(),
  addOutboundAttachment: vi.fn(),
  markOutboundSent: vi.fn(),
  archiveToSentFolder: vi.fn(),
}));

// No SMTP server, no database, no IMAP: the mail is built for real and caught on its way out.
vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: mocks.sendMail })) },
}));
vi.mock("../../config/database.js", () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock("../../repositories/inboundEmailRepository.js", () => ({
  listActiveMailboxes: mocks.listActiveMailboxes,
  findInboundEmailById: vi.fn(),
}));
vi.mock("../../repositories/outboundEmailRepository.js", () => ({
  createOutboundEmail: mocks.createOutboundEmail,
  addOutboundAttachment: mocks.addOutboundAttachment,
  markOutboundSent: mocks.markOutboundSent,
}));
vi.mock("./sentFolderArchiver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sentFolderArchiver.js")>()),
  archiveToSentFolder: mocks.archiveToSentFolder,
}));

import { sendComposedEmail, type ComposeRequest } from "./composeService.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PDF = Buffer.from("%PDF-1.4\n%%EOF\n", "latin1");

function request(overrides: Partial<ComposeRequest> = {}): ComposeRequest {
  return {
    regionCode: "TRADE",
    to: "customer@example.com",
    cc: "radhika@renderways.in",
    subject: "WO-036344461-5166159539- Trade",
    body: "Dear Customer",
    bodyHtml: '<p>Dear <b>Customer</b></p><img src="cid:visit-hp-logo@opencall">',
    inReplyToId: null,
    attachments: [{ filename: "5166159539.pdf", mimeType: "application/pdf", content: PDF }],
    allowedRegionCodes: null,
    sentByUserId: "user-1",
    ...overrides,
  };
}

/** The raw message as it went to the SMTP server. */
function wire(): string {
  expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  return (mocks.sendMail.mock.calls[0]![0] as { raw: Buffer }).raw.toString("latin1");
}

/** Headers as a reader sees them: a long one folded onto the next line is still one header. */
function unfolded(raw: string): string {
  return raw.replace(/\r\n[ \t]+/g, " ");
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MAIL_SMTP_HOST = "smtp.example.invalid";
  process.env.MAIL_PASSWORD = "not-a-real-password";
  mocks.listActiveMailboxes.mockResolvedValue([{ regionCode: "TRADE", email: "trade@renderways.in" }]);
  mocks.createOutboundEmail.mockResolvedValue("out-1");
  mocks.sendMail.mockResolvedValue({ messageId: "<nodemailer-made-this-up@renderways.in>" });
});

describe("sending with inline pictures", () => {
  it("shows them in place and does not store them as the mail's attachments", async () => {
    const result = await sendComposedEmail(
      request({
        inlineImages: [
          { cid: "visit-hp-logo@opencall", filename: "hp.png", contentType: "image/png", content: PNG },
        ],
      }),
    );

    // Stored and counted: the estimate only.
    expect(mocks.addOutboundAttachment).toHaveBeenCalledTimes(1);
    expect(mocks.addOutboundAttachment.mock.calls[0]![1]).toMatchObject({ filename: "5166159539.pdf" });
    expect(result.attachmentCount).toBe(1);

    const raw = wire();
    expect(raw).toContain("multipart/related");
    expect(raw).toMatch(/Content-ID: <visit-hp-logo@opencall>/);
    expect(raw).toMatch(/Content-Disposition: inline; filename=hp\.png/);
    expect(raw).toMatch(/Content-Disposition: attachment; filename=5166159539\.pdf/);
  });
});

describe("the Message-ID", () => {
  it("is the one the caller gave, on the mail and in the send record alike", async () => {
    const messageId = "<quotation.4f9c2d0e-8a1b-4c3d-9e2f-0a1b2c3d4e5f.1761800000000@renderways.in>";
    await sendComposedEmail(request({ messageId }));

    expect(unfolded(wire())).toContain(`Message-ID: ${messageId}`);
    expect(mocks.markOutboundSent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "SENT", messageId }),
    );
    // The copy filed in Sent is the very mail that went out.
    expect(mocks.archiveToSentFolder.mock.calls[0]![0].raw.toString("latin1")).toBe(wire());
  });

  it("is left to the mailer when the caller gives none, as before", async () => {
    await sendComposedEmail(request());
    expect(mocks.markOutboundSent).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "<nodemailer-made-this-up@renderways.in>" }),
    );
  });
});
