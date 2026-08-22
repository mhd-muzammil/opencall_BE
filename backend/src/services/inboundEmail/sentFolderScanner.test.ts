import { describe, expect, it } from "vitest";
import { pickSentFolders } from "./sentFolderScanner.js";

describe("pickSentFolders", () => {
  it("returns the folder the server flags as Sent", () => {
    expect(
      pickSentFolders([
        { path: "INBOX" },
        { path: "INBOX.Sent", specialUse: "\\Sent" },
        { path: "INBOX.Trash", specialUse: "\\Trash" },
      ]),
    ).toEqual(["INBOX.Sent"]);
  });

  it("returns EVERY sent folder, not only the flagged one", () => {
    // The whole reason this exists: webmail files into the flagged folder and Outlook makes
    // its own. Stopping at the first match loses half the history.
    expect(
      pickSentFolders([
        { path: "INBOX" },
        { path: "INBOX.Sent", specialUse: "\\Sent" },
        { path: "INBOX.Sent Items" },
      ]),
    ).toEqual(["INBOX.Sent", "INBOX.Sent Items"]);
  });

  it("puts the flagged folder first even when it is listed last", () => {
    expect(
      pickSentFolders([
        { path: "INBOX.Sent Items" },
        { path: "INBOX.Sent Mail" },
        { path: "INBOX.Sent", specialUse: "\\Sent" },
      ]),
    ).toEqual(["INBOX.Sent", "INBOX.Sent Items", "INBOX.Sent Mail"]);
  });

  it("does not list the same folder twice when it is both flagged and named", () => {
    expect(
      pickSentFolders([{ path: "INBOX.Sent", specialUse: "\\Sent" }, { path: "INBOX.Sent" }]),
    ).toEqual(["INBOX.Sent"]);
  });

  it("matches the leaf name under either separator", () => {
    expect(pickSentFolders([{ path: "INBOX/Sent Messages" }])).toEqual(["INBOX/Sent Messages"]);
    expect(pickSentFolders([{ path: "Sent" }])).toEqual(["Sent"]);
  });

  it("is case insensitive about the name", () => {
    expect(pickSentFolders([{ path: "INBOX.SENT ITEMS" }])).toEqual(["INBOX.SENT ITEMS"]);
  });

  it("does not mistake a folder that merely starts with the letters", () => {
    // "Sentinel" begins with sent and is not a Sent folder; the word boundary is what says so.
    expect(pickSentFolders([{ path: "INBOX.Sentinel" }, { path: "INBOX.Sentry" }])).toEqual([]);
  });

  it("does not match a folder with Sent in the middle of the name", () => {
    // Anchored, so "Unsent drafts" — somewhere mail never left from — stays out.
    expect(pickSentFolders([{ path: "INBOX.Unsent drafts" }, { path: "INBOX.Not Sent" }])).toEqual(
      [],
    );
  });

  it("ignores entries with no path", () => {
    expect(pickSentFolders([{ specialUse: "\\Sent" }, { path: "  " }, { path: "Sent" }])).toEqual([
      "Sent",
    ]);
  });

  it("returns nothing when the mailbox has no sent folder at all", () => {
    expect(pickSentFolders([{ path: "INBOX" }, { path: "INBOX.Trash" }])).toEqual([]);
  });
});
