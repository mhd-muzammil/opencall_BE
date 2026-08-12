import { describe, expect, it } from "vitest";
import { detectEscalation } from "./escalationDetector.js";

// HIGH is what a coordinator must pick up first, so the line between "named an escalation"
// and "sounds impatient" is the thing worth pinning down.

describe("HIGH — the sender has named it an escalation", () => {
  it("flags an Elevation call, which is what HP calls an escalation", () => {
    const r = detectEscalation({
      subject: "Re: WO-035461590-5163244186 Elevation Call",
      body: "Hello Team, Replace the monitor subject to warranty if there is no crack.",
    });
    expect(r.level).toBe("HIGH");
    expect(r.reasons).toContain("“Elevation” in subject");
  });

  it("flags the word escalation in the subject, in any form", () => {
    for (const subject of [
      "Escalation - WO-035073100",
      "Please escalate this call",
      "ESCALATED: no engineer yet",
    ]) {
      expect(detectEscalation({ subject, body: "" }).level).toBe("HIGH");
    }
  });

  it("flags a message signed by an Escalation Manager even with a plain subject", () => {
    const r = detectEscalation({
      subject: "WO-035461590 monitor replacement",
      body: "Regards\nSanthosh Kumar L\nEscalation Manager\nHP India",
    });
    expect(r.level).toBe("HIGH");
    expect(r.reasons).toContain("From an Escalation Manager");
  });

  it("flags legal wording", () => {
    const r = detectEscalation({
      subject: "Service pending",
      body: "If not resolved we will approach the consumer court.",
    });
    expect(r.level).toBe("HIGH");
    expect(r.reasons).toContain("Threat of legal action");
  });
});

describe("WATCH — impatient, but not named an escalation", () => {
  it("flags urgency without promoting it to HIGH", () => {
    const r = detectEscalation({ subject: "Urgent: printer down", body: "Please send someone." });
    expect(r.level).toBe("WATCH");
    expect(r.reasons).toContain("Urgent");
  });

  it("flags chasing and repeat follow-ups", () => {
    expect(
      detectEscalation({ subject: "WO-1 update", body: "Still no response from your side." }).level,
    ).toBe("WATCH");
    expect(
      detectEscalation({ subject: "3rd reminder", body: "Please act." }).level,
    ).toBe("WATCH");
  });

  it("flags plain dissatisfaction", () => {
    const r = detectEscalation({
      subject: "Service",
      body: "Very disappointed with the poor service.",
    });
    expect(r.level).toBe("WATCH");
    expect(r.reasons).toContain("Dissatisfaction");
  });
});

describe("NONE — ordinary mail", () => {
  it("leaves a routine message alone", () => {
    const r = detectEscalation({
      subject: "Support Call ( 5163174072 & WO-035454458 ) registered with HP",
      body: "Dear Customer, Greetings From HP. Thank you for contacting us.",
    });
    expect(r).toEqual({ level: "NONE", reasons: [] });
  });

  it("never escalates machine mail — HP's own acknowledgements quote the word", () => {
    const r = detectEscalation({
      subject: "Auto: Escalation received",
      body: "This is an automated response. Escalation Manager will contact you.",
      isAutoReply: true,
    });
    expect(r.level).toBe("NONE");
  });

  it("survives empty input", () => {
    expect(detectEscalation({ subject: "", body: "" }).level).toBe("NONE");
  });
});

describe("reasons", () => {
  it("collects every signal so the UI can explain the flag", () => {
    const r = detectEscalation({
      subject: "Escalation - urgent",
      body: "Third reminder, still no response. Very disappointed.",
    });
    expect(r.level).toBe("HIGH");
    expect(r.reasons.length).toBeGreaterThan(2);
    expect(r.reasons).toContain("“Escalation” in subject");
    expect(r.reasons).toContain("Urgent");
  });
});

describe("the disclaimer footer is not the sender's words", () => {
  it("does not flag HP's routine acknowledgement, whose footer says “Legal Disclaimer”", () => {
    // This exact shape flagged 51 of 67 real messages HIGH before the footer was stripped.
    const r = detectEscalation({
      subject: "Support Call ( 5163174072 & WO-035454458 ) registered with HP",
      body: [
        "Dear Customer, Greetings From HP. Thank you for contacting us.",
        "Warm Regards",
        "Hp Support Team",
        "",
        "Legal Disclaimer :",
        "This email is confidential. If received in error, delete it immediately.",
      ].join("\n"),
    });
    expect(r.level).toBe("NONE");
  });

  it("still reads an escalation written above the footer", () => {
    const r = detectEscalation({
      subject: "WO-1 pending",
      body: [
        "This is my third reminder and still no response.",
        "",
        "Confidentiality Notice: delete immediately if not intended.",
      ].join("\n"),
    });
    expect(r.level).toBe("WATCH");
    expect(r.reasons).toContain("Repeat follow-up");
  });

  it("needs a real threat, not the word “legal”", () => {
    expect(
      detectEscalation({ subject: "x", body: "Legal Disclaimer : confidential" }).level,
    ).toBe("NONE");
    expect(
      detectEscalation({ subject: "x", body: "We will take legal action." }).level,
    ).toBe("HIGH");
  });
});
