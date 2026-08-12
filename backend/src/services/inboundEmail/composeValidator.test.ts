import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_RECIPIENTS,
  checkCompose,
  parseRecipients,
} from "./composeValidator.js";

// These are the only checks between a typed address and a real mail leaving the company's
// domain over its own name, so each one is pinned.

const valid = {
  fromEmail: "salem@renderways.in",
  to: "customer@example.com",
  cc: "",
  subject: "WO-035104670 update",
  body: "Your call has been scheduled for tomorrow.",
  attachmentBytes: 0,
};

describe("parseRecipients", () => {
  it("splits on commas, semicolons and newlines", () => {
    expect(parseRecipients("a@x.com, b@x.com; c@x.com\nd@x.com")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
    ]);
  });

  // Copying a row out of Outlook gives "Name <addr>", which is what people actually paste.
  it("unwraps a display name", () => {
    expect(parseRecipients("Bhupesh Sharma <bhupesh.sharma@hp.com>")).toEqual([
      "bhupesh.sharma@hp.com",
    ]);
  });

  // The comma inside an unquoted surname is a separator everywhere else; splitting on it
  // used to invent a recipient called "sharma".
  it("does not invent a recipient from an unquoted surname", () => {
    expect(parseRecipients("Sharma, Bhupesh <bhupesh.sharma@hp.com>")).toEqual([
      "bhupesh.sharma@hp.com",
    ]);
  });

  it("handles a quoted display name and several pasted rows", () => {
    expect(
      parseRecipients(`"Sharma, Bhupesh" <a@hp.com>; Antin A <b@flex.com>, c@x.com`),
    ).toEqual(["a@hp.com", "b@flex.com", "c@x.com"]);
  });

  // A genuine typo must still surface as an error rather than silently disappearing.
  it("keeps a bare token that is not a display name", () => {
    expect(parseRecipients("customer@example.com, notanemail")).toEqual([
      "customer@example.com",
      "notanemail",
    ]);
  });

  it("lower-cases and removes duplicates", () => {
    expect(parseRecipients("A@X.com, a@x.com")).toEqual(["a@x.com"]);
  });

  it("ignores empty pieces and stray separators", () => {
    expect(parseRecipients(" , ; \n a@x.com ,")).toEqual(["a@x.com"]);
    expect(parseRecipients("")).toEqual([]);
  });
});

describe("checkCompose", () => {
  it("accepts a well-formed mail", () => {
    const result = checkCompose(valid);
    expect(result.error).toBeNull();
    expect(result.to).toEqual(["customer@example.com"]);
  });

  it("requires at least one recipient", () => {
    expect(checkCompose({ ...valid, to: "" }).error).toMatch(/at least one recipient/i);
  });

  it("names the address that is wrong rather than failing silently", () => {
    const result = checkCompose({ ...valid, to: "customer@example.com, notanemail" });
    expect(result.error).toContain("notanemail");
  });

  it("rejects an address with no top-level domain", () => {
    expect(checkCompose({ ...valid, to: "someone@localhost" }).error).toMatch(/not a valid/i);
  });

  it("validates cc as strictly as to", () => {
    expect(checkCompose({ ...valid, cc: "bad@@x.com" }).error).toMatch(/not a valid/i);
  });

  // The cap is what keeps an ordinary thread from turning into a mailshot by accident.
  it("caps the recipient count", () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `p${i}@x.com`).join(",");
    expect(checkCompose({ ...valid, to: many }).error).toMatch(/too many recipients/i);
  });

  it("allows exactly the cap", () => {
    const many = Array.from({ length: MAX_RECIPIENTS }, (_, i) => `p${i}@x.com`).join(",");
    expect(checkCompose({ ...valid, to: many }).error).toBeNull();
  });

  it("requires a subject and a body", () => {
    expect(checkCompose({ ...valid, subject: "   " }).error).toMatch(/add a subject/i);
    expect(checkCompose({ ...valid, body: "  \n " }).error).toMatch(/empty/i);
  });

  it("rejects attachments over the total ceiling", () => {
    expect(
      checkCompose({ ...valid, attachmentBytes: MAX_ATTACHMENT_TOTAL_BYTES + 1 }).error,
    ).toMatch(/over \d+ MB/i);
  });

  it("requires a real from address", () => {
    expect(checkCompose({ ...valid, fromEmail: "" }).error).toMatch(/which mailbox/i);
  });
});
