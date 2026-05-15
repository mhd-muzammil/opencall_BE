import { parseCustomDate } from "../../utils/dateParser.js";

/**
 * WIP Aging Calculator
 *
 * Calculates WIP aging in business days (excluding Sundays) between a
 * case-created timestamp and a reference "now" timestamp.
 *
 * Rules:
 * 1. Sundays are NOT counted.
 * 2. The aging only ticks over to the next day once the time-of-day of the
 *    original creation moment is reached on the reference date.
 *    Example: created 07-05-2026 08:27 PM → on 14-05-2026 04:00 PM the aging
 *    is 5 (not 6, because 08:27 PM has not been reached yet).
 * 3. All calculations are performed in Asia/Kolkata (IST, UTC+05:30).
 *
 * @module wipAgingCalculator
 */

/** IST offset in milliseconds (UTC+05:30). */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Shift a UTC timestamp to an IST-aligned Date whose `.getUTC*` methods
 * return IST calendar values (day-of-week, hours, minutes, etc.).
 *
 * This avoids depending on the server's local timezone.
 */
function toIstAligned(date: Date): Date {
  return new Date(date.getTime() + IST_OFFSET_MS);
}

/**
 * Returns the IST day-of-week (0 = Sun … 6 = Sat) for a UTC Date.
 */
function istDayOfWeek(date: Date): number {
  return toIstAligned(date).getUTCDay();
}

/**
 * Returns the number of milliseconds elapsed since midnight IST on the
 * same IST calendar day.
 */
function istTimeOfDayMs(date: Date): number {
  const ist = toIstAligned(date);
  return (
    ist.getUTCHours() * 3600_000 +
    ist.getUTCMinutes() * 60_000 +
    ist.getUTCSeconds() * 1000 +
    ist.getUTCMilliseconds()
  );
}

/**
 * Returns midnight IST of the IST calendar day that contains `date`.
 * The returned Date is in UTC but represents 00:00 IST.
 */
function istMidnight(date: Date): Date {
  const ist = toIstAligned(date);
  const midnightIst = Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate(),
  );
  // Convert back from IST-aligned to true UTC
  return new Date(midnightIst - IST_OFFSET_MS);
}

/**
 * Count business days (Mon–Sat, i.e. excluding Sundays) between two
 * IST midnight-aligned dates (start inclusive, end exclusive).
 *
 * `startMidnight` and `endMidnight` must both be midnight-IST UTC dates.
 */
function countBusinessDays(startMidnight: Date, endMidnight: Date): number {
  const oneDay = 86_400_000;
  let count = 0;
  let cursor = startMidnight.getTime();
  const end = endMidnight.getTime();

  while (cursor < end) {
    // Check IST day of week for the cursor
    const cursorDate = new Date(cursor);
    if (istDayOfWeek(cursorDate) !== 0) {
      // 0 = Sunday → skip
      count++;
    }
    cursor += oneDay;
  }

  return count;
}

/**
 * Calculate WIP aging in business days.
 *
 * @param caseCreatedTime – ISO-8601 string or Date of when the case was created.
 * @param now             – The reference point (defaults to `new Date()`).
 * @returns The WIP aging as a whole number string, or `null` if `caseCreatedTime`
 *          is missing / unparseable.
 */
export function calculateWipAging(
  caseCreatedTime: string | Date | null | undefined,
  now?: Date,
): string | null {
  if (caseCreatedTime === null || caseCreatedTime === undefined || caseCreatedTime === "") {
    return null;
  }

  const created = parseCustomDate(caseCreatedTime);

  if (!created) {
    return null;
  }

  const reference = now ?? new Date();

  // If the reference is before the creation time, aging is 0.
  if (reference.getTime() <= created.getTime()) {
    return "0";
  }

  // Step 1: get IST midnights for both dates
  const createdMidnight = istMidnight(created);
  const referenceMidnight = istMidnight(reference);

  // Step 2: count full business days between the two midnights
  let aging = countBusinessDays(createdMidnight, referenceMidnight);

  // Step 3: if the reference time-of-day has NOT yet reached the
  //         creation time-of-day, subtract 1 (the current partial day
  //         hasn't "completed" yet).
  const createdTimeOfDay = istTimeOfDayMs(created);
  const referenceTimeOfDay = istTimeOfDayMs(reference);

  if (referenceTimeOfDay < createdTimeOfDay) {
    // But only subtract if the reference day itself would have counted
    // (i.e. it's not a Sunday).
    aging = Math.max(0, aging - 1);
  }

  // Step 4: if created and reference fall on the same calendar day (IST),
  //         aging is 0 regardless.
  if (createdMidnight.getTime() === referenceMidnight.getTime()) {
    return "0";
  }

  return String(aging);
}
