import { describe, expect, it } from "vitest";
import { pickSentFolder } from "./sentFolderArchiver.js";

// Picking the wrong folder files a customer's mail somewhere nobody looks; picking none
// means webmail shows no record that it was ever sent. Both are silent failures, so the
// choice is pinned here.

describe("pickSentFolder", () => {
  it("prefers the folder the server flags as \\Sent", () => {
    const boxes = [
      { path: "INBOX" },
      { path: "Elementos enviados", specialUse: "\\Sent" },
      { path: "Sent" },
    ];
    // The flagged one wins even though a folder literally called "Sent" also exists — the
    // server knows which one its client actually uses.
    expect(pickSentFolder(boxes)).toBe("Elementos enviados");
  });

  it("falls back to a known name when nothing is flagged", () => {
    expect(pickSentFolder([{ path: "INBOX" }, { path: "Sent" }])).toBe("Sent");
  });

  it("matches the cPanel/Dovecot INBOX.Sent layout", () => {
    expect(pickSentFolder([{ path: "INBOX" }, { path: "INBOX.Sent" }])).toBe("INBOX.Sent");
  });

  it("matches case-insensitively and ignores surrounding space", () => {
    expect(pickSentFolder([{ path: " Sent Items " }])).toBe(" Sent Items ");
    expect(pickSentFolder([{ path: "SENT MAIL" }])).toBe("SENT MAIL");
  });

  // Better to report nothing than to file a customer's mail into Drafts or Trash.
  it("returns null rather than guessing", () => {
    expect(pickSentFolder([{ path: "INBOX" }, { path: "Trash" }, { path: "Drafts" }])).toBeNull();
    expect(pickSentFolder([])).toBeNull();
  });

  it("ignores a flagged entry that has no path", () => {
    expect(pickSentFolder([{ specialUse: "\\Sent" }, { path: "Sent" }])).toBe("Sent");
  });
});
