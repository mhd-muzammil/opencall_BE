/**
 * Chooses which of the two FieldEZ address columns to trust for a work order.
 *
 * WHY THIS IS NOT "PREFER CUSTOMER ADDRESS"
 * -----------------------------------------
 * Measured on a live Flex WIP export (626 rows / 521 unique tickets):
 *
 *   both columns present            573   (425 byte-identical)
 *   the two disagree                148   (Common longer on 88, Customer on 60)
 *   Common Address only              50
 *   Customer Address only             1
 *   neither                           2
 *
 * So on 425 of 573 rows the choice is moot. It is the 148 disagreements that
 * decide the quality of everything built on top, and there Customer Address
 * loses on two counts:
 *
 *  1. TRUNCATION. Its median length is exactly 62 characters and rows end
 *     mid-token — "…Above More Super Market, Kosapet -". The locality is
 *     usually the part that gets cut, which is precisely the part we need.
 *
 *  2. WRONG SITE. It sometimes holds an address that is not where the engineer
 *     is going. One live row reads "Arshiya Free Trade Warhousing Zone wh-4,
 *     Sai Village, Tal-Panvel, Dist.-Raigad" — Maharashtra — on a call whose
 *     Common Address, city and pincode all say Sriperumbudur, Tamil Nadu.
 *
 * Hence: score both against evidence the row itself carries (its own pincode
 * and city), penalise truncation, and only fall back to a fixed preference when
 * the evidence genuinely ties.
 *
 * NOTHING HERE GUESSES. When both candidates are unusable the result is
 * `source: "none"` and a null text. A blank address that the caller can see is
 * blank is worth more than a plausible wrong one.
 *
 * Pure and deterministic: same input, same output, no clock and no I/O. That is
 * what makes it safe to run over history and to unit-test against real rows.
 */

import { cleanString, normalizePincode } from "../normalization/valueNormalizer.js";

/** Which column the chosen text came from. */
export type AddressSource = "customer" | "common" | "none";

export interface AddressCandidateFields {
  customerAddress?: string | null;
  commonAddress?: string | null;
  customerCity?: string | null;
  customerState?: string | null;
  customerPincode?: string | null;
}

export interface SelectedAddress {
  /** The address text to use, already cleaned. Null when nothing is usable. */
  text: string | null;
  source: AddressSource;
  /** Validated 6-digit Indian pincode, or null. */
  pincode: string | null;
  /** Diagnostics — why this candidate won. Never drives behaviour. */
  reason: AddressSelectionReason;
}

export interface AddressSelectionReason {
  customerScore: number | null;
  commonScore: number | null;
  customerTruncated: boolean;
  commonTruncated: boolean;
  /** True when one candidate is a strict prefix of the other. */
  prefixRelation: boolean;
}

/**
 * Values that occupy the cell without being an address. Mirrors the
 * carry-forward placeholder list — the same junk reaches every manual column.
 */
const PLACEHOLDER_VALUES = new Set([
  "",
  "-",
  "--",
  ".",
  "n/a",
  "na",
  "nil",
  "none",
  "null",
  "undefined",
  "not applicable",
  "not available",
  "unknown",
  "test",
]);

/**
 * An address needs more than a token to be worth anything. "Chennai" alone is
 * the pincode tier's job, not the geocoder's.
 */
const MIN_USEFUL_LENGTH = 8;

/**
 * Trailing characters that mean the string was cut off rather than finished.
 * A real address does not end on a separator.
 */
const DANGLING_TAIL = /[-,;:/&+(]$/;

/**
 * A valid Indian PIN is exactly 6 digits and never starts with 0.
 *
 * `normalizePincode` only strips non-digits, so a phone number typed into the
 * Pincode column survives it and then silently misses every lookup. Everything
 * downstream treats the pincode as trustworthy, so it is validated properly
 * here rather than at the point of use.
 */
export function toIndianPincode(value: unknown): string | null {
  const digits = normalizePincode(value);
  return digits !== null && /^[1-9]\d{5}$/.test(digits) ? digits : null;
}

/**
 * Collapses text that repeats itself, an artifact seen in Common Address:
 * "SalemSalemSalem", and one row where the whole address appears twice
 * separated by a space. Left alone it doubles the length of what we would send
 * to a geocoder and skews every length comparison here.
 *
 * Two shapes are handled: exact periodic repetition (no separator), and one
 * doubling with an optional separator between the halves.
 */
export function collapseRepeats(value: string): string {
  const text = value.trim();

  // Guard the backreference regex below against pathological input. Real
  // addresses top out around 280 characters.
  if (text.length > 512) {
    return text;
  }

  // "SalemSalemSalem" -> "Salem". Shortest period wins, so triples collapse too.
  for (let period = 1; period <= text.length / 2; period += 1) {
    if (text.length % period !== 0) {
      continue;
    }
    if (text.slice(0, period).repeat(text.length / period) === text) {
      return text.slice(0, period).trim();
    }
  }

  // "<addr> <addr>" with an optional separator between the halves.
  const doubled = text.match(/^(.{8,}?)[\s,;-]*\1$/i);
  return doubled ? doubled[1]!.trim() : text;
}

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Cleaned, de-duplicated address text, or null when it is not an address. */
function toCandidate(value: string | null | undefined): string | null {
  const cleaned = cleanString(value);
  if (cleaned === null) {
    return null;
  }

  if (PLACEHOLDER_VALUES.has(cleaned.toLowerCase())) {
    return null;
  }

  const collapsed = collapseRepeats(cleaned);
  if (collapsed.length < MIN_USEFUL_LENGTH) {
    return null;
  }

  // A cell holding only digits (a stray pincode or phone number) is not an
  // address, however long it is.
  return /[a-z]/i.test(collapsed) ? collapsed : null;
}

function looksTruncated(text: string): boolean {
  return DANGLING_TAIL.test(text.trim());
}

/**
 * Drops a trailing separator left behind by truncation.
 *
 * Applied only to the text we hand out, never before scoring — `looksTruncated`
 * must still be able to see that the cut happened. When BOTH candidates are
 * truncated the better one still wins and still ends on a dangling character,
 * and shipping "…Kosapet -, Vellore, 632001" to a geocoder is needless noise.
 */
function stripDanglingTail(text: string): string {
  let result = text.trim();
  while (result.length > 0 && DANGLING_TAIL.test(result)) {
    result = result.slice(0, -1).trim();
  }
  return result;
}

/**
 * How much this candidate is worth. Only evidence the row already carries is
 * used — its own pincode and city — so the score never depends on an external
 * lookup that could change underneath a historical report.
 */
function scoreCandidate(
  text: string,
  pincode: string | null,
  city: string | null,
): number {
  const haystack = normalizeForCompare(text);
  let score = 0;

  // Agreeing with the row's own pincode is the strongest single signal that
  // this address belongs to this work order — it is what the Raigad row failed.
  if (pincode && haystack.includes(pincode)) {
    score += 40;
  }

  // The city is a weaker version of the same check, and the one that catches
  // the Raigad case (its city cell says Sriperumbudur).
  const normalizedCity = city ? normalizeForCompare(city) : "";
  if (normalizedCity.length >= 4 && haystack.includes(normalizedCity)) {
    score += 25;
  }

  // A cut-off address loses its tail, which is where the locality lives.
  if (looksTruncated(text)) {
    score -= 30;
  }

  // Completeness, with diminishing returns so a rambling address cannot
  // outweigh the evidence checks above.
  score += Math.min(text.length, 120) / 10;

  return score;
}

/**
 * Pick the address to use for a work order.
 *
 * Tie-break order when scores are equal:
 *   1. the candidate the other is a strict prefix of (the prefix is truncated)
 *   2. Common Address
 *
 * Step 2 deviates from a naive "Customer Address is the primary column" reading
 * on purpose — see the measurements in the file header. It only ever applies
 * when the two disagree AND score identically, which the evidence checks make
 * rare.
 */
export function selectAddress(fields: AddressCandidateFields): SelectedAddress {
  const customer = toCandidate(fields.customerAddress);
  const common = toCandidate(fields.commonAddress);
  const pincode = toIndianPincode(fields.customerPincode);
  const city = cleanString(fields.customerCity);

  const customerScore = customer === null ? null : scoreCandidate(customer, pincode, city);
  const commonScore = common === null ? null : scoreCandidate(common, pincode, city);

  // A strict prefix is a truncated copy of the longer one, whatever the scores
  // say. Checked on the normalized forms so punctuation differences do not hide
  // the relation.
  let prefixRelation = false;
  if (customer !== null && common !== null) {
    const a = normalizeForCompare(customer);
    const b = normalizeForCompare(common);
    prefixRelation = a !== b && (b.startsWith(a) || a.startsWith(b));
  }

  const reason: AddressSelectionReason = {
    customerScore,
    commonScore,
    customerTruncated: customer !== null && looksTruncated(customer),
    commonTruncated: common !== null && looksTruncated(common),
    prefixRelation,
  };

  const emit = (text: string, source: AddressSource): SelectedAddress => ({
    text: stripDanglingTail(text),
    source,
    pincode,
    reason,
  });

  // Both present is the only case that needs a decision; ordered first so the
  // single-candidate paths below narrow cleanly.
  if (customer !== null && common !== null) {
    if (prefixRelation) {
      const customerIsPrefix =
        normalizeForCompare(common).startsWith(normalizeForCompare(customer));
      return customerIsPrefix ? emit(common, "common") : emit(customer, "customer");
    }

    return customerScore! > commonScore!
      ? emit(customer, "customer")
      : emit(common, "common");
  }

  if (customer !== null) {
    return emit(customer, "customer");
  }
  if (common !== null) {
    return emit(common, "common");
  }

  return { text: null, source: "none", pincode, reason };
}

/**
 * The full string worth sending to a geocoder: the chosen address plus the city
 * and state it needs to disambiguate. "Gandhi Road" resolves anywhere; "Gandhi
 * Road, Vellore, Tamil Nadu 632001" resolves once.
 *
 * Parts already contained in the address are not repeated — a duplicated city
 * measurably hurts some providers' scoring.
 */
export function buildGeocodeQuery(fields: AddressCandidateFields): string | null {
  const selected = selectAddress(fields);
  if (selected.text === null) {
    return null;
  }

  const parts = [selected.text];
  const haystack = normalizeForCompare(selected.text);

  for (const extra of [fields.customerCity, fields.customerState]) {
    const cleaned = cleanString(extra);
    if (!cleaned) {
      continue;
    }
    const normalized = normalizeForCompare(cleaned);
    if (normalized.length >= 3 && !haystack.includes(normalized)) {
      parts.push(cleaned);
    }
  }

  if (selected.pincode && !haystack.includes(selected.pincode)) {
    parts.push(selected.pincode);
  }

  return parts.join(", ");
}
