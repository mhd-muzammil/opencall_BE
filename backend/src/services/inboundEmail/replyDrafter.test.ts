import { describe, expect, it } from "vitest";
import { blockedReason, draftBody, replySubject } from "./replyDrafter.js";

// Stage 2 runs in approval mode, so the rules that matter most are the ones about when a
// reply may exist at all, and about never stating a status we are not sure of.

type DraftArgs = Parameters<typeof draftBody>[0];

function input(overrides: Partial<DraftArgs> = {}): DraftArgs {
  return {
    subject: "WO-035073100 update",
    fromName: "Ravi Kumar",
    fromEmail: "ravi@acme.test",
    regionCode: "SALEM",
    isAutoReply: false,
    matchConfidence: "HIGH",
    call: {
      ticketId: "WO-035073100",
      status: "Part Order Pending",
      engineer: "Suresh",
      product: "HP LaserJet Pro M405dn",
      customerName: "Ravi Kumar",
    },
    ...overrides,
  };
}

describe("blockedReason", () => {
  it("blocks a reply to machine mail — that is how loops start", () => {
    expect(blockedReason({ isAutoReply: true, alreadySent: false })).toMatch(/loop/i);
  });

  it("blocks a second reply to the same message", () => {
    expect(blockedReason({ isAutoReply: false, alreadySent: true })).toMatch(/already/i);
  });

  it("allows a normal customer message", () => {
    expect(blockedReason({ isAutoReply: false, alreadySent: false })).toBe("");
  });
});

describe("replySubject", () => {
  it("adds Re: once", () => {
    expect(replySubject("Printer down")).toBe("Re: Printer down");
  });

  it("does not stack a second Re:", () => {
    expect(replySubject("Re: Printer down")).toBe("Re: Printer down");
    expect(replySubject("RE : Printer down")).toBe("RE : Printer down");
  });

  it("falls back when there is no subject", () => {
    expect(replySubject("")).toBe("Re: your service request");
  });
});

describe("draftBody with a confident match", () => {
  it("states the live status back to the customer", () => {
    const body = draftBody(input());
    expect(body).toContain("Dear Ravi,");
    expect(body).toContain("WO-035073100");
    expect(body).toContain("Part Order Pending");
    expect(body).toContain("Suresh");
    expect(body).toContain("HP LaserJet Pro M405dn");
    expect(body).toContain("Renderways Technology Private Limited");
  });

  it("omits fields the report does not have rather than printing blanks", () => {
    const body = draftBody(
      input({
        call: {
          ticketId: "WO-1",
          status: "",
          engineer: "",
          product: "",
          customerName: "Ravi",
        },
      }),
    );
    expect(body).toContain("Work order : WO-1");
    expect(body).not.toContain("Status     :");
    expect(body).not.toContain("Engineer   :");
  });

  it("uses the first name from a “Last, First” sender", () => {
    const body = draftBody(
      input({
        fromName: "L, Santosh",
        call: { ...input().call!, customerName: "" },
      }),
    );
    expect(body).toContain("Dear Santosh,");
  });

  it("never greets someone by their email address", () => {
    const body = draftBody(
      input({
        fromName: "fsmsupport.india@flex.com",
        call: { ...input().call!, customerName: "" },
      }),
    );
    expect(body).toContain("Dear Sir/Madam,");
  });
});

describe("draftBody without a confident match", () => {
  // A LOW match is the sender's address matching SOME call of theirs — quoting a status
  // from it could tell a customer about the wrong call.
  it("promises nothing and asks for the WO number when the match is only a guess", () => {
    const body = draftBody(input({ matchConfidence: "LOW" }));
    expect(body).toContain("confirm the work order number");
    expect(body).not.toContain("Part Order Pending");
    expect(body).not.toContain("Suresh");
  });

  it("asks for the WO number when there is no call at all", () => {
    const body = draftBody(input({ call: null, matchConfidence: "NONE" }));
    expect(body).toContain("confirm the work order number");
    expect(body).toContain("Renderways Technology Private Limited");
  });
});
