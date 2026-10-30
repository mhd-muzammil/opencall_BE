import { describe, expect, it } from "vitest";
import { quotationIdsInHeaders, quotationMessageId, quotationOfMessageId } from "./quotationMessageId.js";

const ID = "4f9c2d0e-8a1b-4c3d-9e2f-0a1b2c3d4e5f";
const OTHER = "0b6f1e2d-3c4b-4a59-8e7f-6a5b4c3d2e1f";

describe("quotationMessageId", () => {
  it("names the quotation, lower-cased, at the moment it was sent", () => {
    expect(quotationMessageId(ID.toUpperCase(), 1761800000000)).toBe(
      `<quotation.${ID}.1761800000000@renderways.in>`,
    );
  });
});

describe("quotationOfMessageId", () => {
  it("reads the quotation back out of the id", () => {
    expect(quotationOfMessageId(quotationMessageId(ID))).toBe(ID);
  });

  it("reads an id handed back with a folded header's leading space, in any case", () => {
    expect(quotationOfMessageId(` <QUOTATION.${ID.toUpperCase()}.1@RENDERWAYS.IN>`)).toBe(ID);
  });

  it("finds nothing in an ordinary Message-ID, or in a malformed one", () => {
    expect(quotationOfMessageId("<abc123@webmail.renderways.in>")).toBeNull();
    expect(quotationOfMessageId("<quotation.------------------------------------.1@x>")).toBeNull();
    expect(quotationOfMessageId(undefined)).toBeNull();
  });
});

describe("quotationIdsInHeaders", () => {
  it("finds the quotation a reply answers, in In-Reply-To", () => {
    expect(quotationIdsInHeaders({ "in-reply-to": quotationMessageId(ID) })).toEqual([ID]);
  });

  it("finds every quotation further up the thread, in References, once each", () => {
    const references = `<abc@gmail.com> ${quotationMessageId(ID)} ${quotationMessageId(OTHER)} ${quotationMessageId(ID, 5)}`;
    expect(quotationIdsInHeaders({ references }).sort()).toEqual([ID, OTHER].sort());
  });

  it("finds our own mail's id, as a branch mailbox on CC receives it", () => {
    expect(quotationIdsInHeaders({ "message-id": quotationMessageId(ID) })).toEqual([ID]);
  });

  it("finds nothing in an ordinary thread", () => {
    expect(quotationIdsInHeaders({ "in-reply-to": "<CAF+abc@mail.gmail.com>", references: "" })).toEqual([]);
    expect(quotationIdsInHeaders({})).toEqual([]);
  });
});
