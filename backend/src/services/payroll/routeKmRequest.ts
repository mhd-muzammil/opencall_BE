import { MAX_KM_RANGE_DAYS, daysInKmRange } from "./rosterKmRange.js";

/**
 * What the KM Report may ask for its ROUTE KM table, checked before anything
 * reaches Payroll.
 *
 * The period is held to daysInKmRange, the rule the RTPL APP KM table above it
 * is held to, so any real period that table takes, this one takes too. Each
 * date must also be a real day first: daysInKmRange checks only the YYYY-MM-DD
 * shape, so it would ask about 30 February, and month 00 makes it throw.
 */

/** The most ids one request may carry; Payroll refuses more. */
export const MAX_ROUTE_KM_ENGINEERS = 300;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS = /^\d+$/;

const RANGE_MESSAGE =
  `from and to must be YYYY-MM-DD dates, in order, at most ${MAX_KM_RANGE_DAYS} days apart`;
const IDS_MESSAGE =
  `engineer_ids must be a list of 1 to ${MAX_ROUTE_KM_ENGINEERS} Payroll employee ids`;

/** A YYYY-MM-DD that is on the calendar: not 2026-02-30, not month 13. */
function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** A Payroll employee id: a positive whole number, or its digits (a URL sends text). */
function toEngineerId(value: unknown): number | null {
  const id = typeof value === "string" && DIGITS.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export type RouteKmRequest =
  | { ok: true; engineerIds: number[]; from: string; to: string }
  | { ok: false; message: string };

/**
 * The body of POST /route-km: {from, to, engineer_ids}.
 *
 * The ids are Payroll employee ids, so nothing is matched by name here. Each is
 * asked about once, in the order first given: a repeat would only make Payroll
 * answer for the same engineer twice.
 */
export function parseRouteKmRequest(body: unknown, todayIso: string): RouteKmRequest {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const { from, to, engineer_ids: rawIds } = fields;

  if (!isCalendarDay(from) || !isCalendarDay(to) || !daysInKmRange(from, to, todayIso)) {
    return { ok: false, message: RANGE_MESSAGE };
  }

  // Counted as sent, before repeats are dropped, so a huge list is refused
  // before any of it is read.
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > MAX_ROUTE_KM_ENGINEERS) {
    return { ok: false, message: IDS_MESSAGE };
  }
  const engineerIds = new Set<number>();
  for (const raw of rawIds) {
    const id = toEngineerId(raw);
    if (id === null) return { ok: false, message: IDS_MESSAGE };
    engineerIds.add(id);
  }

  return { ok: true, engineerIds: [...engineerIds], from, to };
}

/**
 * The query of the three GET .../stored endpoints: ?from=&to=&engineer_ids=1,2,3.
 * The same checks as POST /route-km's body; the ids arrive as one comma-separated
 * value, since a GET carries no body.
 */
export function parseStoredKmQuery(query: unknown, todayIso: string): RouteKmRequest {
  const fields = typeof query === "object" && query !== null ? (query as Record<string, unknown>) : {};
  const rawIds = fields.engineer_ids;
  const ids = typeof rawIds === "string" && rawIds.trim() !== "" ? rawIds.split(",").map((id) => id.trim()) : rawIds;
  return parseRouteKmRequest({ from: fields.from, to: fields.to, engineer_ids: ids }, todayIso);
}

export type RouteKmDayRequest =
  | { ok: true; engineerId: number; date: string }
  | { ok: false; message: string };

/** The :engineerId and ?date of GET /route-km/day/engineer/:engineerId -- one cell of the table. */
export function parseRouteKmDayRequest(
  engineerIdParam: unknown,
  dateQuery: unknown,
): RouteKmDayRequest {
  const engineerId = toEngineerId(engineerIdParam);
  if (engineerId === null) {
    return { ok: false, message: "engineerId must be a Payroll employee id" };
  }
  if (!isCalendarDay(dateQuery)) {
    return { ok: false, message: "date must be a YYYY-MM-DD date" };
  }
  return { ok: true, engineerId, date: dateQuery };
}
