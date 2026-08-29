/**
 * Which of the mail in the inbox belongs behind the CAB button.
 *
 * Two kinds, both from the same desk and read together: cab mail, and the big spare / big
 * part / big product traffic. There is no field that says so — it all arrives in the same
 * region mailboxes as everything else — so it is recognised by the words themselves, in the
 * sender's address or in the subject.
 *
 * A PLAIN SUBSTRING WOULD BE WRONG. "cab" sits inside cable, cabinet, cabling and Cabot, and
 * "big" sits inside bigger; a filter that pulled in every mail about a cable would be worse
 * than no filter, because the whole point of the button is to see this desk's mail without
 * everything else. So each word has to stand alone — bounded by something that is not a
 * letter or a digit, or by the start or end.
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

/**
 * What the CAB button matches: `cab`/`cabs` as a word, or `big` followed by spare/part/
 * product.
 *
 * The second half is the same desk's other traffic — "Big Spare Part", "Big Parts required",
 * "Big Product replacement" — which is read alongside the cab mail and was arriving in the
 * inbox with everything else. The button's name stays CAB because that is what it says on
 * screen; what it gathers is that desk's mail.
 *
 * `big` is bounded on its left and joined to the next word by anything that is not a letter
 * or a digit, so "bigger part" cannot match — after `big` comes `g`, and the separator must
 * be a separator. Zero separators are allowed too, which catches "bigspare" without letting
 * "bigger" through.
 */
export const CAB_MAIL_PATTERN =
  "(^|[^a-z0-9])(cabs?([^a-z0-9]|$)|big[^a-z0-9]*(spare|part|product))";

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
