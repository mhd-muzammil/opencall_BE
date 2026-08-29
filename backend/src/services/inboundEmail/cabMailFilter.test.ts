import { describe, expect, it } from "vitest";
import { isCabMail } from "./cabMailFilter.js";

/**
 * The rule these pin is the one the SQL filter runs — same pattern string, handed to the
 * query as a parameter. Anything that changes here changes what the CAB button shows.
 */

describe("isCabMail", () => {
  it("finds it in the sender's address", () => {
    expect(isCabMail("cab@renderways.in", "Trip completed")).toBe(true);
    expect(isCabMail("bookings@cab.co.in", "Trip completed")).toBe(true);
    expect(isCabMail("CAB@RENDERWAYS.IN", "anything")).toBe(true);
  });

  it("finds it in the subject", () => {
    expect(isCabMail("someone@example.com", "Cab booking for tomorrow")).toBe(true);
    expect(isCabMail("someone@example.com", "Taxi cab receipt")).toBe(true);
    expect(isCabMail("someone@example.com", "CAB")).toBe(true);
  });

  it("reads the plural as the same word", () => {
    expect(isCabMail("cabs@example.com", "x")).toBe(true);
    expect(isCabMail("x@example.com", "Two cabs booked")).toBe(true);
  });

  it("finds the big spare / big part / big product mail from the same desk", () => {
    expect(isCabMail("x@example.com", "BIG SPARE PART required")).toBe(true);
    expect(isCabMail("x@example.com", "Big Parts pending approval")).toBe(true);
    expect(isCabMail("x@example.com", "Big Product replacement")).toBe(true);
    expect(isCabMail("x@example.com", "Re: big spares for WO-035640797")).toBe(true);
    expect(isCabMail("bigparts@example.com", "anything")).toBe(true);
  });

  it("joins big to its word across punctuation, or none at all", () => {
    expect(isCabMail("x@example.com", "BIG-SPARE approval")).toBe(true);
    expect(isCabMail("x@example.com", "[BIG_PART] 4471")).toBe(true);
    expect(isCabMail("x@example.com", "bigspare request")).toBe(true);
  });

  it("does NOT match bigger, however it is followed", () => {
    // The separator between big and its word must actually be a separator. Without that,
    // "bigger part" reads as big + part and every mail about a larger anything arrives.
    expect(isCabMail("x@example.com", "bigger part needed")).toBe(false);
    expect(isCabMail("x@example.com", "biggest product in stock")).toBe(false);
    expect(isCabMail("x@example.com", "Bigham spare")).toBe(false);
  });

  it("does NOT match big on its own, or big beside anything else", () => {
    // "Big" alone is a common word; the button would fill with mail about big customers,
    // big issues and big delays.
    expect(isCabMail("x@example.com", "Big delay on this call")).toBe(false);
    expect(isCabMail("x@example.com", "big customer escalation")).toBe(false);
  });

  it("does NOT match a word that merely contains those letters", () => {
    // The reason the rule is a word and not a substring. A filter that pulled in every mail
    // about a cable would be worse than no filter — the button exists to leave everything
    // else out.
    expect(isCabMail("support@cablenet.com", "Cable replacement quote")).toBe(false);
    expect(isCabMail("x@example.com", "Cabinet key missing")).toBe(false);
    expect(isCabMail("x@example.com", "Cabling work at site")).toBe(false);
    expect(isCabMail("x@example.com", "Mr Cabot called")).toBe(false);
  });

  it("still finds the word when punctuation is against it", () => {
    expect(isCabMail("hp-cab-desk@example.com", "x")).toBe(true);
    expect(isCabMail("x@example.com", "Re: [CAB] trip 4471")).toBe(true);
    expect(isCabMail("x@example.com", "cab.")).toBe(true);
  });

  it("is false for ordinary customer mail", () => {
    expect(isCabMail("customer@gmail.com", "Printer not working")).toBe(false);
    expect(isCabMail("tsd_hsr2@ashokleyland.com", "WO-035640797 update")).toBe(false);
  });

  it("does not fall over on blanks", () => {
    expect(isCabMail("", "")).toBe(false);
    expect(isCabMail(null as unknown as string, undefined as unknown as string)).toBe(false);
  });
});
