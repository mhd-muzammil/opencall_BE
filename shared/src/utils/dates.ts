// Calendar-date helpers for RCA text. These operate on CALENDAR dates only (no
// time-of-day, no timezone maths inside): the caller passes a date string and
// gets an ordinal label or a shifted calendar date back. "Today in Asia/Kolkata"
// is produced by the caller (see istTodayIso) and handed in as a plain date, so
// these stay pure and trivially testable.

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
 * Parse the two date shapes the app produces:
 *   - ISO "YYYY-MM-DD..." (our server-generated "today")
 *   - Indian "DD-MM-YYYY..." or "DD/MM/YYYY..." (Flex case_created_time)
 * A leading 4-digit group means year-first; otherwise day-first. Trailing time
 * (" 14:30") is ignored. Returns null when unparseable.
 */
export function parseFlexibleDate(input: string | null | undefined): CalendarDate | null {
  const text = String(input ?? "").trim();
  if (!text) return null;

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
 * Today's calendar date in Asia/Kolkata as "YYYY-MM-DD". This is the one place
 * that reads the clock; pass its result into the pure helpers above so tests
 * stay deterministic. `now` is injectable for testing.
 */
export function istTodayIso(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD; the timeZone option pins it to IST.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
