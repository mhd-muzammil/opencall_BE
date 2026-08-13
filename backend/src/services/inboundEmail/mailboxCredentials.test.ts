import { describe, expect, it } from "vitest";
import { mailboxPassword, passwordEnvName } from "./mailboxCredentials.js";

// Getting this wrong means repeated failed IMAP logins against a shared cPanel host, which
// is how the sending IP gets blocked and every region's ingest stops at once.

describe("passwordEnvName", () => {
  it("keys off the address's local part", () => {
    expect(passwordEnvName("hosur@renderways.in")).toBe("MAIL_HOSUR_PASSWORD");
    expect(passwordEnvName("salem@renderways.in")).toBe("MAIL_SALEM_PASSWORD");
  });

  it("makes a typeable name out of punctuation", () => {
    expect(passwordEnvName("tn-south@renderways.in")).toBe("MAIL_TN_SOUTH_PASSWORD");
    expect(passwordEnvName("k.puram@renderways.in")).toBe("MAIL_K_PURAM_PASSWORD");
  });

  it("is case-insensitive and ignores stray space", () => {
    expect(passwordEnvName("  Hosur@Renderways.IN ")).toBe("MAIL_HOSUR_PASSWORD");
  });
});

describe("mailboxPassword", () => {
  const env = {
    MAIL_PASSWORD: "shared-2025",
    MAIL_HOSUR_PASSWORD: "hosur-2026",
  };

  it("prefers the mailbox's own password", () => {
    expect(mailboxPassword("hosur@renderways.in", env)).toBe("hosur-2026");
  });

  // The three mailboxes that already worked must keep working with no config change.
  it("falls back to the shared password", () => {
    expect(mailboxPassword("salem@renderways.in", env)).toBe("shared-2025");
    expect(mailboxPassword("vellore@renderways.in", env)).toBe("shared-2025");
  });

  // A blank override is a half-finished edit, not an instruction to log in with "".
  it("ignores an empty or whitespace override", () => {
    expect(mailboxPassword("hosur@renderways.in", { ...env, MAIL_HOSUR_PASSWORD: "" }))
      .toBe("shared-2025");
    expect(mailboxPassword("hosur@renderways.in", { ...env, MAIL_HOSUR_PASSWORD: "   " }))
      .toBe("shared-2025");
  });

  it("returns empty when nothing is configured, so callers report it as unconfigured", () => {
    expect(mailboxPassword("chennai@renderways.in", {})).toBe("");
  });

  // A password of only spaces would be a real (if odd) password; only the OVERRIDE is
  // whitespace-checked, because there the fallback is the safer answer.
  it("returns a shared password verbatim", () => {
    expect(mailboxPassword("salem@renderways.in", { MAIL_PASSWORD: " pad " })).toBe(" pad ");
  });
});
