export function cleanString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const cleaned = String(value).trim().replace(/\s+/g, " ");
  return cleaned.length > 0 ? cleaned : null;
}

export function cleanRequiredString(value: unknown): string {
  return cleanString(value) ?? "";
}

export function normalizeIdentifier(value: unknown): string {
  const cleaned = cleanRequiredString(value).toUpperCase();
  return cleaned.replace(/[^A-Z0-9]/g, "");
}

export function normalizeTicketId(value: unknown): string {
  const cleaned = cleanRequiredString(value).toUpperCase();
  const withoutSeparators = cleaned.replace(/[\s_-]+/g, "");
  return withoutSeparators.replace(/[^A-Z0-9]/g, "");
}

export function normalizeCaseId(value: unknown): string {
  return normalizeIdentifier(value).replace(/^CASE/, "");
}

export function normalizePincode(value: unknown): string | null {
  const digits = cleanRequiredString(value).replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

/**
 * Parse a whole-number "aging in days" value from a spreadsheet cell. Tolerates
 * surrounding text (e.g. "23 days") by extracting the first number; returns null
 * when there is no numeric content.
 */
export function parseAgingDays(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function dateFromIstWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond = 0,
): Date {
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - IST_OFFSET_MS,
  );
}

/**
 * Excel serial date (1900 system). Excel counts days from 1899-12-30 — that
 * offset absorbs its 1900-leap-year bug for every date after 1900-03-01.
 *
 * A date cell that carries no number format reaches us as a bare float
 * (46191.559415868054) instead of a Date or a formatted string. The FieldEZ
 * export shipped its whole "Create Time" column this way on 2026-07-21, which
 * blanked every WIP aging that day, so serials are now first-class input.
 */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;
/** ~1954-10-03 to ~2064-04-08: wide enough for any real case date, narrow
 *  enough that a stray count or id is never mistaken for a timestamp. */
const MIN_EXCEL_SERIAL = 20_000;
const MAX_EXCEL_SERIAL = 60_000;

function excelSerialToDate(serial: number): Date | null {
  if (
    !Number.isFinite(serial) ||
    serial < MIN_EXCEL_SERIAL ||
    serial > MAX_EXCEL_SERIAL
  ) {
    return null;
  }

  // The fractional day is a float, so an exact wall-clock second arrives a few
  // microseconds off. Round to the second before splitting into components.
  const utcMs =
    EXCEL_EPOCH_UTC + Math.round((serial * MS_PER_DAY) / 1000) * 1000;
  const asUtc = new Date(utcMs);

  if (Number.isNaN(asUtc.getTime())) {
    return null;
  }

  // The serial encodes a wall-clock moment with no timezone; FieldEZ exports in
  // IST, matching how Date and string inputs are already interpreted above.
  return dateFromIstWallClock(
    asUtc.getUTCFullYear(),
    asUtc.getUTCMonth() + 1,
    asUtc.getUTCDate(),
    asUtc.getUTCHours(),
    asUtc.getUTCMinutes(),
    asUtc.getUTCSeconds(),
  );
}

export function parseExcelDate(value: unknown): Date | null {
  if (typeof value === "number") {
    return excelSerialToDate(value);
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return dateFromIstWallClock(
      value.getFullYear(),
      value.getMonth() + 1,
      value.getDate(),
      value.getHours(),
      value.getMinutes(),
      value.getSeconds(),
      value.getMilliseconds(),
    );
  }

  const cleaned = cleanString(value)?.replace(/^Cre:\s*/i, "");
  if (!cleaned) {
    return null;
  }

  // The same unformatted cell can arrive pre-stringified depending on the
  // reader ("46191.559415868054"). new Date() rejects it, so catch it here.
  if (/^\d+(?:\.\d+)?$/.test(cleaned)) {
    return excelSerialToDate(Number(cleaned));
  }

  const dayFirstDateTime = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(cleaned);
  if (dayFirstDateTime) {
    const [, day, month, year, hour, minute, second = "0", meridiem] = dayFirstDateTime;
    let normalizedHour = Number(hour);

    if (meridiem) {
      const upperMeridiem = meridiem.toUpperCase();
      if (upperMeridiem === "AM" && normalizedHour === 12) {
        normalizedHour = 0;
      } else if (upperMeridiem === "PM" && normalizedHour < 12) {
        normalizedHour += 12;
      }
    }

    const parsed = dateFromIstWallClock(
      Number(year),
      Number(month),
      Number(day),
      normalizedHour,
      Number(minute),
      Number(second),
    );

    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(cleaned);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
