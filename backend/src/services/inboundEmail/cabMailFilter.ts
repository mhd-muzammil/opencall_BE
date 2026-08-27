/**
 * Which of the mail in the inbox is about cabs.
 *
 * There is no field that says so — cab mail arrives in the same region mailboxes as
 * everything else — so it is recognised by the word itself, in the sender's address or in
 * the subject.
 *
 * A PLAIN SUBSTRING WOULD BE WRONG. "cab" sits inside cable, cabinet, cabling and Cabot, and
 * a filter that pulled in every mail about a cable would be worse than no filter: the whole
 * point of the button is to see cab mail without everything else. So the word has to stand
 * alone — bounded by something that is not a letter or a digit, or by the start or end.
 *
 * ONE PATTERN, USED TWICE. The filtering happens in SQL, because the mail for one week can
 * be older than the page the list happens to hold and a filter applied to the loaded page
 * would show nothing and look like there was no cab mail. But a rule written only in SQL is
 * a rule nothing can test, so the pattern lives here and is handed to the query as a
 * parameter. `isCabMail` below runs the very same string, which is what the tests exercise.
 *
 * The syntax is deliberately the intersection of Postgres and JavaScript regular
 * expressions: `\y` and `\b` mean the same thing and neither engine understands the other's,
 * so an explicit character class is used instead and both read it identically.
 */

/** `cab` or `cabs`, standing as its own word. Case-insensitive at the point of use. */
export const CAB_MAIL_PATTERN = "(^|[^a-z0-9])cabs?([^a-z0-9]|$)";

/**
 * Does this message look like cab mail?
 *
 * Exported for the tests that pin the rule; the running filter is the SQL that uses the same
 * pattern. If the two ever disagree, they disagree here first.
 */
export function isCabMail(fromEmail: string, subject: string): boolean {
  const test = new RegExp(CAB_MAIL_PATTERN, "i");
  return test.test(String(fromEmail ?? "")) || test.test(String(subject ?? ""));
}
