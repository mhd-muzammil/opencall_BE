import { describe, expect, it, vi } from "vitest";

// The verifier's module reaches for the database and the mailbox list on import; neither is
// what these tests are about.
vi.mock("../../config/database.js", () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));

import { pickSentMail, type SentMailCandidate } from "./quotationSendVerifier.js";
import { quotationMessageId } from "./quotationMessageId.js";

/**
 * Which mail in the Sent folder carried a quotation out. The customer now commonly has two
 * quotations close together — the Visit, then the Part on the same job — and the Visit's mail
 * must never be read as the Part going out.
 */

const PART = { quotationNo: "RTPL/26-27/QEN/81", createdAt: "2026-10-29 16:00:00+05:30" };

function mail(uid: number, iso: string, subject: string): SentMailCandidate {
  return { uid, date: new Date(iso), to: "customer@example.com", subject };
}

const VISIT_MAIL = mail(10, "2026-10-29T09:01:00+05:30", "Quotation RTPL/26-27/QEV/5 — WO-036344461");

describe("pickSentMail", () => {
  it("does not take the Visit's earlier mail as the Part's send", () => {
    expect(pickSentMail([VISIT_MAIL], PART)).toBeNull();
  });

  it("takes the Part's own mail, sent after it was raised", () => {
    const own = mail(11, "2026-10-29T16:20:00+05:30", "Quotation RTPL/26-27/QEN/81 — WO-036344461");
    expect(pickSentMail([VISIT_MAIL, own], PART)).toEqual({ date: own.date, to: "customer@example.com" });
  });

  it("skips a later mail that names a different quotation, such as a Visit re-sent", () => {
    const resent = mail(12, "2026-10-29T16:05:00+05:30", "Quotation RTPL/26-27/QEV/5 — WO-036344461");
    expect(pickSentMail([VISIT_MAIL, resent], PART)).toBeNull();
  });

  it("counts a hand-written mail that names no quotation, sent after it was raised", () => {
    const webmail = mail(13, "2026-10-29T17:00:00+05:30", "Your estimate");
    expect(pickSentMail([VISIT_MAIL, webmail], PART)?.date).toEqual(webmail.date);
  });

  it("takes the earliest of its own mails, when it was chased", () => {
    const first = mail(14, "2026-10-29T16:10:00+05:30", "Quotation RTPL/26-27/QEN/81 — WO-036344461");
    const chase = mail(15, "2026-10-30T10:00:00+05:30", "Re: Quotation RTPL/26-27/QEN/81 — WO-036344461");
    expect(pickSentMail([chase, first, VISIT_MAIL], PART)?.date).toEqual(first.date);
  });

  it("allows a few minutes of clock drift between the mail and the database", () => {
    const drift = mail(16, "2026-10-29T15:57:00+05:30", "Quotation RTPL/26-27/QEN/81 — WO-036344461");
    expect(pickSentMail([drift], PART)?.date).toEqual(drift.date);
  });

  it("does not mistake QEN/8 for QEN/81", () => {
    const other = mail(17, "2026-10-29T16:30:00+05:30", "Quotation RTPL/26-27/QEN/8 — WO-1");
    expect(pickSentMail([other], PART)).toBeNull();
  });

  it("finds nothing in a mail with no date", () => {
    expect(pickSentMail([{ uid: 18, date: null, to: "", subject: "Quotation RTPL/26-27/QEN/81" }], PART)).toBeNull();
  });
});

describe("pickSentMail, for mail sent from here", () => {
  const PART_ID = "4f9c2d0e-8a1b-4c3d-9e2f-0a1b2c3d4e5f";
  const VISIT_ID = "0b6f1e2d-3c4b-4a59-8e7f-6a5b4c3d2e1f";
  const PART_CHECK = { ...PART, id: PART_ID };
  // The Visit mail's subject is the trade desk's and names no quotation number.
  const visitSend = (uid: number, iso: string) => ({
    ...mail(uid, iso, "WO-036344461-5166159539- Trade"),
    messageId: `<quotation.${VISIT_ID}.1761800000000@renderways.in>`,
  });

  it("does not take a Visit re-sent after the Part was raised as the Part's send", () => {
    expect(pickSentMail([visitSend(20, "2026-10-29T16:30:00+05:30")], PART_CHECK)).toBeNull();
  });

  it("takes the mail whose Message-ID names this quotation", () => {
    const own = {
      ...mail(21, "2026-10-29T16:40:00+05:30", "WO-036344461-5166159539- Trade"),
      messageId: `<quotation.${PART_ID}.1761800000001@renderways.in>`,
    };
    expect(pickSentMail([visitSend(20, "2026-10-29T16:30:00+05:30"), own], PART_CHECK)?.date).toEqual(own.date);
  });

  it("still counts a hand-written mail with an ordinary Message-ID", () => {
    const webmail = { ...mail(22, "2026-10-29T17:00:00+05:30", "Your estimate"), messageId: "<abc123@webmail.renderways.in>" };
    expect(pickSentMail([visitSend(20, "2026-10-29T16:30:00+05:30"), webmail], PART_CHECK)?.date).toEqual(webmail.date);
  });

  it("reads a Message-ID handed back with its fold's leading space", () => {
    const folded = { ...visitSend(24, "2026-10-29T16:30:00+05:30"), messageId: ` <quotation.${VISIT_ID}.1@renderways.in>` };
    expect(pickSentMail([folded], PART_CHECK)).toBeNull();
  });

  it("reads the Message-ID whatever its case", () => {
    const shouting = { ...visitSend(23, "2026-10-29T16:30:00+05:30"), messageId: `<QUOTATION.${VISIT_ID.toUpperCase()}.1@RENDERWAYS.IN>` };
    expect(pickSentMail([shouting], PART_CHECK)).toBeNull();
    expect(pickSentMail([shouting], { ...PART, id: VISIT_ID })?.date).toEqual(shouting.date);
  });
});

describe("quotationMessageId", () => {
  it("names the quotation in a form pickSentMail reads back", () => {
    const id = quotationMessageId("4F9C2D0E-8A1B-4C3D-9E2F-0A1B2C3D4E5F", 1761800000000);
    expect(id).toBe("<quotation.4f9c2d0e-8a1b-4c3d-9e2f-0a1b2c3d4e5f.1761800000000@renderways.in>");
    const sent = { ...mail(30, "2026-10-29T16:30:00+05:30", "WO-1-2- Trade"), messageId: id };
    expect(pickSentMail([sent], { ...PART, id: "4f9c2d0e-8a1b-4c3d-9e2f-0a1b2c3d4e5f" })).not.toBeNull();
    expect(pickSentMail([sent], { ...PART, id: "0b6f1e2d-3c4b-4a59-8e7f-6a5b4c3d2e1f" })).toBeNull();
  });
});
