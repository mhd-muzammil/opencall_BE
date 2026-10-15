/**
 * OpenCall -> Payroll integration client.
 *
 * The Payroll app (separate Django project) owns the engineer-facing case app
 * and the live GPS store. OpenCall pushes case assignments into Payroll and
 * reads live tracking back out. This is the ONLY place that talks to Payroll's
 * HTTP API, mirroring the existing FLEX_RAW_API integration pattern.
 *
 * Config (read from process.env so this file needs no edit to env.ts; add these
 * keys to config/env.ts later if you want strict validation):
 *   PAYROLL_API_URL       e.g. https://payrollback.systimus.in  (or http://localhost:8000)
 *   PAYROLL_API_USER      a Payroll staff/admin service account username
 *   PAYROLL_API_PASSWORD  its password
 *
 * When PAYROLL_API_URL is unset the integration is simply unavailable and
 * isPayrollConfigured() returns false — callers should degrade gracefully.
 */

const BASE = (process.env.PAYROLL_API_URL ?? "").replace(/\/+$/, "");
const USER = process.env.PAYROLL_API_USER ?? "";
const PASSWORD = process.env.PAYROLL_API_PASSWORD ?? "";

export function isPayrollConfigured(): boolean {
  return Boolean(BASE && USER && PASSWORD);
}

// Cached JWT so we don't re-login on every call.
let accessToken: string | null = null;
let tokenExpiresAt = 0;

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`Payroll login failed (${res.status})`);
  }
  const data = (await res.json()) as { access: string };
  accessToken = data.access;
  // SimpleJWT access tokens default to ~5 min; refresh a bit early.
  tokenExpiresAt = Date.now() + 4 * 60 * 1000;
  return accessToken;
}

async function token(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  return login();
}

async function authed<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!isPayrollConfigured()) {
    throw new Error("Payroll integration is not configured (set PAYROLL_API_URL).");
  }
  const doFetch = async (jwt: string) =>
    fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
        ...(init.headers ?? {}),
      },
    });

  let res = await doFetch(await token());
  if (res.status === 401) {
    // Token expired/invalid — force a fresh login once.
    accessToken = null;
    res = await doFetch(await token());
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Payroll API ${path} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

// ---- Case dispatch (OpenCall -> Payroll) --------------------------------

export interface PayrollCaseInput {
  customer_name: string;
  customer_phone?: string;
  title: string;
  description?: string;
  address?: string;
  latitude?: number | null;
  longitude?: number | null;
  priority?: "low" | "medium" | "high" | "urgent";
  // Originating-system reference (OpenCall ticket id) — makes dispatch idempotent
  // so re-sending the same ticket updates the one case instead of duplicating.
  external_ref?: string;
}

export interface PayrollCase {
  id: number;
  case_number: string;
  status: string;
  assigned_to: number | null;
  assigned_to_name?: string | null;
}

export async function createCase(input: PayrollCaseInput): Promise<PayrollCase> {
  return authed<PayrollCase>("/api/cases/", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Assign by engineer name/email/id — Payroll resolves whichever is provided. */
export async function assignCase(
  caseId: number,
  engineer: {
    engineer_name?: string;
    engineer_email?: string;
    engineer_phone?: string;
    engineer_id?: number;
  },
): Promise<PayrollCase> {
  return authed<PayrollCase>(`/api/cases/${caseId}/assign/`, {
    method: "POST",
    body: JSON.stringify(engineer),
  });
}

/**
 * Convenience: create a case and immediately assign it to an engineer.
 *
 * The engineer in OpenCall and the employee in Payroll are separate DB records
 * linked only by identity. Pass email, phone and name when you have them —
 * Payroll matches email first, then phone (both unique + stable), then the
 * (case-insensitive) name. Email/phone are strongly preferred; name-only
 * matching breaks on any spelling or formatting difference between the systems.
 */
export async function dispatchCase(
  input: PayrollCaseInput,
  engineer: { email?: string | null; phone?: string | null; name?: string | null },
): Promise<PayrollCase> {
  if (!engineer.email && !engineer.phone && !engineer.name) {
    throw new Error("dispatchCase needs the engineer's email, phone or name to match a Payroll employee.");
  }
  const created = await createCase(input);
  const ref: { engineer_email?: string; engineer_phone?: string; engineer_name?: string } = {};
  if (engineer.email) ref.engineer_email = engineer.email;
  if (engineer.phone) ref.engineer_phone = engineer.phone;
  if (engineer.name) ref.engineer_name = engineer.name;
  return assignCase(created.id, ref);
}

// ---- Bulk dispatch / backfill (OpenCall -> Payroll) ----------------------

export interface PayrollBulkCaseInput {
  // Idempotency key — the OpenCall ticket id. Re-syncing updates the one case.
  external_ref: string;
  customer_name?: string;
  customer_phone?: string;
  title: string;
  description?: string;
  address?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  // External status hint: "assigned"/"active" | "completed"/"closed" | "cancelled".
  // Lets a backfill land already-finished calls as completed so they don't
  // clutter the engineer's ACTIVE list while still showing in their history.
  status?: string;
  engineer_id?: number;
  engineer_email?: string | null;
  engineer_phone?: string | null;
  engineer_name?: string | null;
  // Everything the engineer needs on site, stored by Payroll as-is. Sent as a
  // bag rather than named columns so a new report column reaches their phone
  // without a migration on the Payroll side.
  details?: Record<string, string>;
}

export interface PayrollBulkResult {
  created: number;
  updated: number;
  assigned: number;
  skipped: number;
  // Previously-synced cases no longer in the pushed set, marked cancelled (not deleted).
  cancelled?: number;
  total: number;
  // Engineer names Payroll has no employee for — their tickets were skipped, so
  // these people need onboarding before their cases can appear.
  unmatched_engineers?: string[];
  // Matched employees with no login: the case exists but nobody can open it.
  unreachable_engineers?: string[];
  details: Array<{
    external_ref: string | null;
    result: string;
    reason?: string;
    engineer_name?: string | null;
    case_number?: string;
    engineer?: string;
    status?: string;
  }>;
}

/**
 * Push MANY cases in one call (the "Sync assigned cases to Payroll" backfill).
 * Each item is idempotent on external_ref, so re-syncing the same day never
 * duplicates. Payroll resolves each engineer by id/email/phone/name and skips
 * (reports) any it can't match rather than failing the whole batch.
 */
export async function bulkDispatchCases(
  cases: PayrollBulkCaseInput[],
  /** The plan day this batch speaks for (YYYY-MM-DD). Payroll stamps it on every
   *  case so an engineer's list can show today's plan and let yesterday's drop
   *  off on its own, without depending on a sweep having run. */
  planDate?: string,
): Promise<PayrollBulkResult> {
  return authed<PayrollBulkResult>("/api/cases/bulk_dispatch/", {
    method: "POST",
    body: JSON.stringify(planDate ? { cases, plan_date: planDate } : { cases }),
  });
}

// ---- Engineer scorecards (OpenCall -> Payroll) --------------------------

export interface PayrollScorecardRow {
  engineer_name: string;
  engineer_email?: string;
  engineer_phone?: string;
  assigned: number;
  attended: number;
  closed: number;
  /** Closes since the 1st of the month, for the month-to-date target. */
  month_closed: number;
}

export interface PayrollScorecardResult {
  saved: number;
  zeroed: number;
  skipped: Array<{ engineer_name: string | null; reason: string }>;
}

/**
 * Push today's Assigned / Attended / Closed per engineer, plus the standing
 * target, so the engineer's own phone shows the same figures as the Engineer
 * Productivity page. One row per engineer, replaced in place on the Payroll
 * side; an engineer Payroll cannot match is reported, not fatal.
 */
export async function pushEngineerScorecards(input: {
  asOf: string;
  dailyTarget: number;
  monthlyTarget: number;
  rows: PayrollScorecardRow[];
}): Promise<PayrollScorecardResult> {
  return authed<PayrollScorecardResult>("/api/cases/scorecards/", {
    method: "POST",
    body: JSON.stringify({
      as_of: input.asOf,
      daily_target: input.dailyTarget,
      monthly_target: input.monthlyTarget,
      rows: input.rows,
    }),
  });
}

// ---- Live tracking (Payroll -> OpenCall) --------------------------------

export interface LiveEngineer {
  engineer_id: number;
  engineer_name: string;
  branch: string | null;

  // Duty is what the engineer DECLARED in Payroll, so an engineer whose phone
  // stopped reporting stays on this list with stale=true rather than vanishing.
  on_duty: boolean;
  duty_started_at: string;
  duty_minutes: number;
  stale: boolean;
  last_seen_minutes: number | null;
  // Kilometres covered since this duty began.
  distance_km: number;

  // Null until the engineer's first GPS fix of the duty arrives.
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  speed: number | null;
  status: string;
  timestamp: string | null;
  active_case_id: number | null;
  active_case_number: string | null;
}


/**
 * The same trail with each fix moved onto the road it was taken on. Payroll
 * caches this per engineer-day, so reading it costs nothing extra.
 *
 * `source` says how much of it is real: "ola" all of it, "partial" a snapped
 * body with the newest few fixes still raw, "raw" none of it — Payroll has no
 * key, or Ola was unreachable. Absent entirely when no date was asked for.
 */
export interface RoadPath {
  points: Array<[number, number]>;
  snapped: number;
  raw: number;
  source: "ola" | "partial" | "raw";
}

export interface TrackPath {
  count: number;
  total_km: number;
  road_path?: RoadPath;
  points: Array<{
    latitude: number;
    longitude: number;
    accuracy: number | null;
    timestamp: string;
  }>;
}

export async function getLiveEngineers(): Promise<LiveEngineer[]> {
  return authed<LiveEngineer[]>("/api/tracking/live/");
}

/**
 * One row per engineer for a day, whatever state they are in. Unlike
 * getLiveEngineers this keeps someone who has finished their shift, so their day
 * can still be opened and reviewed.
 */
export interface RosterEngineer {
  // Null when Payroll has no employee answering to the name we asked under —
  // the same gap that makes that engineer's cases get skipped.
  engineer_id: number | null;
  // The name WE asked under, so the board reads the way our users know them.
  engineer_name: string;
  // The Payroll record it resolved to, for when the two spellings differ.
  payroll_name: string | null;
  matched: boolean;
  branch: string | null;
  state: "on_duty" | "checked_out" | "absent" | "unmatched";
  on_duty: boolean;
  duty_started_at: string | null;
  duty_ended_at: string | null;
  duty_minutes: number;
  auto_closed: boolean;
  distance_km: number;
  stale: boolean;
  last_seen_minutes: number | null;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  status: string;
  timestamp: string | null;
  active_case_id: number | null;
  active_case_number: string | null;
  // The employee's role and department in Payroll. Optional: a Payroll not yet
  // redeployed sends neither.
  role?: string | null;
  department?: string | null;
  // Not in our engineer register: Payroll's other staff, added to the live
  // tracking board on request (see rosterStaff.ts).
  staff?: boolean;
}

/**
 * Every active Payroll employee and their duty state for a day -- Payroll's
 * whole staff, not our register. Only the live tracking board asks for this,
 * to show the office staff beside the engineers; see withStaff().
 */
export async function getRosterAll(date?: string): Promise<RosterEngineer[]> {
  const qs = date ? `?date=${encodeURIComponent(date)}` : "";
  return authed<RosterEngineer[]>(`/api/tracking/roster/${qs}`);
}

/**
 * Duty state for the engineers we name, resolved by PAYROLL.
 *
 * The names come from our own register, but the matching is deliberately not
 * done here: Payroll owns the alias table and the rules that decide where a case
 * goes, so asking it to resolve means an engineer who can receive a case can
 * always be tracked. Matching on this side instead lost the duty state for any
 * name only the alias table could resolve — the engineer read as off duty while
 * standing in a customer's shop.
 *
 * Payroll returns a row per name asked for, including the ones it cannot match.
 */
/** How an engineer is identified to Payroll. Email and phone are unique there and
 *  are what actually resolves a person; the name alone is ambiguous. */
export interface RosterEngineerRef {
  name: string;
  email?: string | null;
  phone?: string | null;
}

export async function getRosterFor(
  engineers: RosterEngineerRef[],
  date?: string,
): Promise<RosterEngineer[]> {
  // The SAME three keys the case dispatch sends. Sending only the name made the
  // board disagree with the cases: a ticket reached Praveen because Payroll
  // matched his email, while the roster asked by name, could not choose between
  // the Praveens, and reported nobody on duty while he was out on a call.
  return authed<RosterEngineer[]>("/api/tracking/roster/", {
    method: "POST",
    body: JSON.stringify(date ? { engineers, date } : { engineers }),
  });
}

/** One engineer's whole day: route, distance, time on duty, stops, timeline. */
export interface EngineerDay {
  engineer_id: number;
  engineer_name: string;
  branch: string | null;
  date: string;
  total_km: number;
  duty_minutes: number;
  first_seen: string | null;
  last_seen: string | null;
  stop_count: number;
  stops: Array<{
    latitude: number;
    longitude: number;
    arrived_at: string;
    left_at: string;
    minutes: number;
    fixes: number;
    case_id: number | null;
    case_number: string | null;
    // The WO number, which is what everyone outside Payroll calls the job.
    case_ref?: string | null;
  }>;
  events: Array<{
    at: string;
    type: string;
    label: string;
    minutes?: number;
    latitude?: number;
    longitude?: number;
    case_number?: string | null;
    case_ref?: string | null;
  }>;
  points: Array<{
    latitude: number;
    longitude: number;
    timestamp: string;
    accuracy: number | null;
    status: string;
  }>;
  road_path?: RoadPath;
}

export async function getEngineerDay(engineerId: number, date?: string): Promise<EngineerDay> {
  const q = new URLSearchParams({ engineer: String(engineerId) });
  if (date) q.set("date", date);
  return authed<EngineerDay>(`/api/tracking/day/?${q.toString()}`);
}

export async function getEngineerPath(engineerId: number, date?: string): Promise<TrackPath> {
  const q = new URLSearchParams({ engineer: String(engineerId) });
  if (date) q.set("date", date);
  return authed<TrackPath>(`/api/tracking/path/?${q.toString()}`);
}

export async function getCasePath(caseId: number): Promise<TrackPath> {
  return authed<TrackPath>(`/api/tracking/path/?case=${caseId}`);
}

// ---- Route km (Payroll -> OpenCall) -------------------------------------

/**
 * Road km for the KM Report's ROUTE KM table: the distance by road through the
 * points an engineer marked on a day, in time order -- their Login, each
 * Check-in, their Logout. Check-outs are not used. Payroll measures it with Ola
 * Directions.
 *
 * A day is "ready" with its km (0 is a real answer), "no_points" when it has
 * fewer than two positions to route between, "failed" when Ola could not route
 * it, and "pending" until Payroll has measured it.
 */
export type RouteKmStatus = "ready" | "no_points" | "failed" | "pending";

export interface RouteKmCell {
  // Null unless the day is "ready".
  km: number | null;
  // How many positions were used (Login, Check-ins, Logout).
  points: number;
  status: RouteKmStatus;
  // A Login or Logout in it was placed at the engineer's office for want of a
  // fix. Optional: passed through as Payroll sends it.
  office?: boolean;
  // Settled for good: a failed day that is will not be measured again.
  final?: boolean;
}

export interface RouteKmRange {
  // False when Payroll has no Ola key; nothing is measured then.
  configured: boolean;
  // The period's days, oldest first, stopping at today.
  days: string[];
  engineers: Array<{ engineer_id: number; days: Record<string, RouteKmCell> }>;
  // Engineer-days not measured yet. Each call measures only a bounded number,
  // so the page asks again until this reaches 0.
  pending: number;
  // How many engineer-days this call measured.
  measured_now: number;
  // Today's measured days still to be read again; polled until 0.
  rechecking?: number;
}

export interface RouteKmPoint {
  kind: "login" | "checkin" | "logout";
  at: string;
  latitude: number;
  longitude: number;
  // The case a check-in was for, when there is one.
  case_number: string | null;
  // A Login or Logout the phone gave no position for, placed at the engineer's
  // office. Optional: passed through as Payroll sends it.
  office?: boolean;
}

export interface RouteKmDay {
  configured: boolean;
  engineer_id: number;
  date: string;
  status: RouteKmStatus;
  km: number | null;
  // In time order, which is the order the route goes through them.
  points: RouteKmPoint[];
  // Ola's road route as [lat, lon]; empty unless the day is "ready".
  path: Array<[number, number]>;
  // Why it failed, when it did; otherwise "".
  error: string;
  // Settled for good: a failed day that is will not be measured again.
  final?: boolean;
}

/**
 * Route km per engineer per day over a period, for engineers named by their
 * Payroll employee id. Payroll measures a bounded number of days per call and
 * answers with what it has, so the caller polls until `pending` is 0.
 */
export async function getRouteKm(
  engineerIds: number[],
  from: string,
  to: string,
): Promise<RouteKmRange> {
  return authed<RouteKmRange>("/api/tracking/route_km/", {
    method: "POST",
    body: JSON.stringify({ engineers: engineerIds, from, to }),
  });
}

/** One engineer-day of it, with its points and Ola's route, for the map beside the table. */
export async function getRouteKmDay(engineerId: number, date: string): Promise<RouteKmDay> {
  const q = new URLSearchParams({ engineer: String(engineerId), date });
  return authed<RouteKmDay>(`/api/tracking/route_km_day/?${q.toString()}`);
}

// ---- FieldEZ km (Payroll -> OpenCall) -----------------------------------

/**
 * Road km for the KM Report's FIELDEZ table, under ROUTE KM: the same route
 * through a day's Login, each Check-in and Logout, in time order, with one
 * difference -- a check-in stands where FieldEZ recorded its work order's
 * "Problem Resolution", not where the app checked in. A check-in FieldEZ has no
 * such place for is left out, never put back at the app's position, and is
 * counted as missing. Payroll measures it with Ola, as it does ROUTE KM.
 *
 * The statuses are ROUTE KM's plus "waiting": the FieldEZ tool has not read the
 * day's work orders yet, so the day is not measured until it has.
 */
export type FieldezKmStatus = RouteKmStatus | "waiting";

export interface FieldezKmCell extends Omit<RouteKmCell, "status"> {
  status: FieldezKmStatus;
  // How many of the day's check-ins were left out for want of a FieldEZ place.
  missing: number;
}

export interface FieldezKmRange extends Omit<RouteKmRange, "engineers"> {
  engineers: Array<{ engineer_id: number; days: Record<string, FieldezKmCell> }>;
  // Engineer-days still waiting for the FieldEZ tool to read their work
  // orders; polled, like pending, until 0.
  waiting: number;
}

export interface FieldezKmDay extends Omit<RouteKmDay, "status"> {
  status: FieldezKmStatus;
  // The check-ins left out of the route, and why.
  missing: Array<{
    case_number: string | null;
    // The check-in's work order; null when its case has none.
    wo: string | null;
    reason: "no_wo" | "fieldez_failed" | "not_in_fieldez" | "no_problem_resolution" | "not_read";
  }>;
  // How many of the day's check-ins the FieldEZ tool has not read yet.
  waiting: number;
}

/**
 * FIELDEZ km per engineer per day over a period, asked the way getRouteKm asks
 * for ROUTE KM. Payroll measures a bounded number of days per call and answers
 * with what it has, so the caller polls until `pending` and `waiting` are 0.
 */
export async function getFieldezKm(
  from: string,
  to: string,
  engineerIds: number[],
): Promise<FieldezKmRange> {
  return authed<FieldezKmRange>("/api/fieldez_km/range/", {
    method: "POST",
    body: JSON.stringify({ engineers: engineerIds, from, to }),
  });
}

/** One engineer-day of it, with its points, Ola's route and the check-ins left out, for the map. */
export async function getFieldezKmDay(engineerId: number, date: string): Promise<FieldezKmDay> {
  const q = new URLSearchParams({ engineer: String(engineerId), date });
  return authed<FieldezKmDay>(`/api/fieldez_km/day/?${q.toString()}`);
}

// ---- Cases by day (Payroll -> OpenCall) ---------------------------------

/**
 * The case line under each day's km in all three of the KM Report's tables:
 * for an engineer-day, how many calls the Live Engineer Tracking day panel
 * lists under "CASES" -- planned for that day, touched on it or visited on it
 * -- and how many of them were closed that day, the panel's "Closed" rows. A
 * call "Closed earlier", on another day, is not closed here. Payroll counts
 * them by the day panel's own rules.
 */
export interface CasesByDayCell {
  cases: number;
  closed: number;
}

export interface CasesByDayRow {
  engineer_id: number;
  // Every day of the period, zeros included.
  days: Record<string, CasesByDayCell>;
}

export interface CasesByDayRange {
  // False only when OpenCall has no Payroll to ask: counting needs no Ola key.
  configured: boolean;
  // The period's days, oldest first, stopping at today.
  days: string[];
  // Each engineer asked about that this Payroll login may see, in the order asked.
  engineers: CasesByDayRow[];
}

/**
 * Cases per engineer per day over a period, asked the way getFieldezKm asks
 * for FIELDEZ km. Payroll counts the whole period in one answer, so unlike the
 * km there is nothing to poll for.
 */
export async function getCasesByDay(
  from: string,
  to: string,
  engineerIds: number[],
): Promise<CasesByDayRange> {
  return authed<CasesByDayRange>("/api/tracking/cases_by_day/", {
    method: "POST",
    body: JSON.stringify({ engineers: engineerIds, from, to }),
  });
}
