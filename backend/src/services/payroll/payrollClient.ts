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
  }>;
  events: Array<{
    at: string;
    type: string;
    label: string;
    minutes?: number;
    latitude?: number;
    longitude?: number;
    case_number?: string | null;
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
