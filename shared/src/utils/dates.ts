// Calendar-date helpers for RCA text. These operate on CALENDAR dates: the
// caller passes a date string and gets an ordinal label or a shifted calendar
// date back. Wall-clock inputs ("2026-07-30", "30-07-2026 04:00 AM") are parsed
// as pure text — no Date is constructed, so no local-timezone drift is possible.
//
// The ONE exception is an input that names an absolute instant (it carries a
// "Z" or a "+05:30" offset). Such a value has no single calendar day until you
// pick a zone, so it is resolved in Asia/Kolkata — the zone this app displays
// every timestamp in. See istCalendarDateOf.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

/**
 * A date-time naming an absolute instant: it carries an explicit UTC designator
 * ("Z") or a numeric offset. Both shapes the app stores land here — JS
 * `Date.toISOString()` ("2026-07-29T22:30:21.000Z") and Postgres
 * `timestamptz::text`, which renders the offset with the minutes omitted when
 * they are zero ("2026-07-30 04:00:21+05:30", "2026-07-29 22:30:21+00").
 */
const ABSOLUTE_INSTANT =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * The Asia/Kolkata calendar date of an absolute-instant string, as
 * "YYYY-MM-DD"; null when `text` is not such a string (the caller then keeps the
 * original text and parses it as a wall-clock date).
 *
 * Why this exists — the RCA "Case Received on {date}" bug: `case_created_time`
 * reaches buildAutoRca as a UTC ISO string (matchingEngine stores
 * `parseCustomDate(...).toISOString()`), so reading its leading date part as
 * text yielded the UTC day. A case created 30-07-2026 04:00:21 IST is stored as
 * "2026-07-29T22:30:21.000Z", and every case created before 05:30 IST was
 * therefore labelled with the PREVIOUS day. The grid's own CASE CREATED TIME
 * column already renders in Asia/Kolkata, so the RCA must agree with it.
 */
function istCalendarDate(text: string): string | null {
  const match = ABSOLUTE_INSTANT.exec(text);
  if (!match) return null;

  // Rebuild as strict ISO 8601 so Date parses it per spec rather than through an
  // engine-specific fallback: "T" separator, and the offset padded to ±HH:MM
  // (Postgres emits "+00" and "+0530"; the spec wants "+00:00" and "+05:30").
  const [, date, time, zone] = match;
  const offset =
    zone!.toUpperCase() === "Z"
      ? "Z"
      : `${zone!.slice(0, 3)}:${zone!.replace(":", "").slice(3) || "00"}`;
  const instant = new Date(`${date}T${time}${offset}`);
  return Number.isNaN(instant.getTime()) ? null : istCalendarDateOf(instant);
}

/**
 * Parse the date shapes the app produces:
 *   - ISO "YYYY-MM-DD..." (our server-generated "today")
 *   - Indian "DD-MM-YYYY..." or "DD/MM/YYYY..." (Flex case_created_time)
 *   - an absolute instant ("...Z" / "...+05:30"), resolved in Asia/Kolkata
 * A leading 4-digit group means year-first; otherwise day-first. Trailing time
 * (" 14:30") is ignored. Returns null when unparseable.
 */
export function parseFlexibleDate(input: string | null | undefined): CalendarDate | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  // An instant only becomes a calendar day once a zone is chosen; everything
  // else is already a wall-clock date and stays on the pure string path.
  const text = istCalendarDate(raw) ?? raw;

  const isoMatch = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text);
  if (isoMatch) {
    return toCalendarDate(
      Number(isoMatch[1]),
      Number(isoMatch[2]),
      Number(isoMatch[3]),
    );
  }

  const dmyMatch = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(text);
  if (dmyMatch) {
    return toCalendarDate(
      Number(dmyMatch[3]),
      Number(dmyMatch[2]),
      Number(dmyMatch[1]),
    );
  }

  return null;
}

function toCalendarDate(year: number, month: number, day: number): CalendarDate | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  return { year, month, day };
}

function ordinalSuffix(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/**
 * "2026-07-19" / "19-07-2026" -> "19th July". Returns "" for an unparseable
 * date so callers can fall back cleanly.
 */
export function formatOrdinalDate(input: string | null | undefined): string {
  const date = parseFlexibleDate(input);
  if (!date) return "";
  const monthName = MONTH_NAMES[date.month - 1];
  if (!monthName) return "";
  return `${date.day}${ordinalSuffix(date.day)} ${monthName}`;
}

/**
 * Add `n` calendar days to a date (rollover-safe across month/year via UTC),
 * returning "YYYY-MM-DD". Returns "" for an unparseable input. Uses UTC so no
 * local-timezone drift can shift the calendar day.
 */
export function addCalendarDays(input: string | null | undefined, n: number): string {
  const date = parseFlexibleDate(input);
  if (!date) return "";
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  utc.setUTCDate(utc.getUTCDate() + n);
  const y = utc.getUTCFullYear();
  const m = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utc.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The Asia/Kolkata calendar date of an absolute instant, as "YYYY-MM-DD". The
 * single place that turns a moment-in-time into a calendar day — never do this
 * with `getUTCDate()` or `toISOString()` (they report the UTC day, which is the
 * PREVIOUS date for anything before 05:30 IST), and never by adding a
 * hardcoded +5:30 in milliseconds (that breaks the moment a zone rule changes).
 */
export function istCalendarDateOf(instant: Date): string {
  // en-CA formats as YYYY-MM-DD; the timeZone option pins it to IST.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/**
 * Today's calendar date in Asia/Kolkata as "YYYY-MM-DD". This is the one place
 * that reads the clock; pass its result into the pure helpers above so tests
 * stay deterministic. `now` is injectable for testing.
 */
export function istTodayIso(now: Date = new Date()): string {
  return istCalendarDateOf(now);
}
