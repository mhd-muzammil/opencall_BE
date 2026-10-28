import { describe, expect, it } from "vitest";
import { legacySanitizeEmailHtml } from "./legacyEmailSanitizer.js";
import { classify, isMadeUpMessageId } from "./refreshInboundEmailBodies.js";

// The refresh rewrites a stored body only when it can prove what that body is: the old rule,
// run again on the same message, must give back exactly what is stored. Anything else is
// left alone or kept apart for its own decision.

const OUTLOOK = `<html><head><style><!--
p.MsoNormal {margin:0cm; font-size:11.0pt; font-family:"Calibri",sans-serif;}
--></style></head><body><p class="MsoNormal">Hi Team,</p></body></html>`;

describe("classify", () => {
  it("refreshes an Outlook mail the old rule stored without its stylesheet", () => {
    const stored = legacySanitizeEmailHtml(OUTLOOK);
    expect(stored).toContain("<style></style>");
    const decision = classify(stored, { html: OUTLOOK, text: "Hi Team," });
    expect(decision.kind).toBe("refresh");
    expect(decision.html).toContain("p.MsoNormal");
  });

  it("refreshes a plain-text mail that was stored with no display copy", () => {
    const decision = classify("", { html: "", text: "Please check.\n-----Original Message-----\nThe part shipped." });
    expect(decision.kind).toBe("refresh");
    expect(decision.html).toContain("-----Original Message-----\nThe part shipped.");
  });

  it("calls a row that already shows what the current code shows current", () => {
    const html = "<p>Hello</p>";
    expect(classify(html, { html, text: "Hello" }).kind).toBe("current");
  });

  // Mail stored before the HTML was kept has an empty body although the message has HTML.
  // That is not proof of anything, so it waits for its own approval.
  it("keeps a body that was never kept apart as never-kept", () => {
    const decision = classify("", { html: OUTLOOK, text: "Hi Team," });
    expect(decision.kind).toBe("never-kept");
    expect(decision.html).toContain("p.MsoNormal");
  });

  it("leaves a body alone when it is not what the old code made of this message", () => {
    expect(classify("<p>edited by hand</p>", { html: OUTLOOK, text: "Hi Team," })).toEqual({
      kind: "different",
    });
  });
});

describe("isMadeUpMessageId", () => {
  it("knows the ids the ingest makes up, which cannot be matched on", () => {
    expect(isMadeUpMessageId("uid-42@kanchipuram@example.com")).toBe(true);
    expect(isMadeUpMessageId("cab-7@salem@example.com")).toBe(true);
    expect(isMadeUpMessageId("verify-9@vellore@example.com")).toBe(true);
    expect(isMadeUpMessageId("")).toBe(true);
  });

  it("takes a real Message-ID as one", () => {
    expect(isMadeUpMessageId("<CAB1234@mail.example.com>")).toBe(false);
  });
});
