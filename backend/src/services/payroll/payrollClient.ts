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
  engineer: { engineer_name?: string; engineer_email?: string; engineer_id?: number },
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
 * linked only by identity. Pass BOTH email and name when you have them — Payroll
 * matches email first (unique + stable), falling back to the (case-insensitive)
 * name. Email is strongly recommended; name-only matching breaks on any spelling
 * or formatting difference between the two systems.
 */
export async function dispatchCase(
  input: PayrollCaseInput,
  engineer: { email?: string | null; name?: string | null },
): Promise<PayrollCase> {
  if (!engineer.email && !engineer.name) {
    throw new Error("dispatchCase needs the engineer's email or name to match a Payroll employee.");
  }
  const created = await createCase(input);
  const ref: { engineer_email?: string; engineer_name?: string } = {};
  if (engineer.email) ref.engineer_email = engineer.email;
  if (engineer.name) ref.engineer_name = engineer.name;
  return assignCase(created.id, ref);
}

// ---- Live tracking (Payroll -> OpenCall) --------------------------------

export interface LiveEngineer {
  engineer_id: number;
  engineer_name: string;
  branch: string | null;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  status: string;
  timestamp: string;
  active_case_id: number | null;
  active_case_number: string | null;
}

export interface TrackPath {
  count: number;
  total_km: number;
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

export async function getEngineerPath(engineerId: number, date?: string): Promise<TrackPath> {
  const q = new URLSearchParams({ engineer: String(engineerId) });
  if (date) q.set("date", date);
  return authed<TrackPath>(`/api/tracking/path/?${q.toString()}`);
}

export async function getCasePath(caseId: number): Promise<TrackPath> {
  return authed<TrackPath>(`/api/tracking/path/?case=${caseId}`);
}
