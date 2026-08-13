/**
 * Which password opens which mailbox.
 *
 * Every mailbox shared one `MAIL_PASSWORD`, which held only while they happened to be set
 * the same. They are not: hosur@renderways.in was reset separately and now differs from the
 * other three. With one shared value, adding hosur would have meant changing the password
 * every other mailbox authenticates with — and a wrong password is not a quiet failure. A
 * few repeated IMAP logins is how a cPanel host decides an address is under attack and
 * blocks the sending IP, taking every region's ingest down at once.
 *
 * So: an optional per-mailbox override, keyed off the address's own local part
 * (`hosur@renderways.in` → `MAIL_HOSUR_PASSWORD`), falling back to the shared
 * `MAIL_PASSWORD`. Nothing has to change for the mailboxes that already work.
 */

export type EnvLike = Record<string, string | undefined>;

/**
 * `hosur@renderways.in` → `MAIL_HOSUR_PASSWORD`.
 *
 * Anything that is not a letter or digit becomes an underscore, so an address like
 * `tn-south@…` maps to a name that is actually typeable in an env file.
 */
export function passwordEnvName(mailboxEmail: string): string {
  const localPart = String(mailboxEmail ?? "").split("@")[0] ?? "";
  const key = localPart.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `MAIL_${key}_PASSWORD`;
}

/**
 * The password for one mailbox: its own if it has one, otherwise the shared value.
 * Returns "" when neither is set, which every caller already treats as "not configured".
 */
export function mailboxPassword(
  mailboxEmail: string,
  env: EnvLike = process.env,
): string {
  const specific = env[passwordEnvName(mailboxEmail)];
  if (specific && specific.trim()) return specific;
  return env.MAIL_PASSWORD ?? "";
}
