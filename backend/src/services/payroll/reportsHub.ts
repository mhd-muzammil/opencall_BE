/**
 * The Reports section's reads from Payroll: the attendance register and the
 * payslips, for a date range. Read-only — both go through payrollGet, which only
 * ever GETs — and slimmed to the fields the reports print, so an employee's
 * bank details or address never leave the server.
 */
import { payrollGet } from "./payrollClient.js";

/** The longest range the Reports section asks for at once (a 25th–24th cycle is at most 31 days). */
export const MAX_REPORTS_RANGE_DAYS = 31;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

export type RangeParse = { ok: true; from: string; to: string } | { ok: false; message: string };

/** `from` and `to` (YYYY-MM-DD, inclusive), in order and at most MAX_REPORTS_RANGE_DAYS long. */
export function parseReportsRange(from: unknown, to: unknown): RangeParse {
  if (typeof from !== "string" || typeof to !== "string" || !isRealDate(from) || !isRealDate(to)) {
    return { ok: false, message: "from and to must be dates (YYYY-MM-DD)" };
  }
  if (from > to) return { ok: false, message: "from must be on or before to" };
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_REPORTS_RANGE_DAYS) {
    return { ok: false, message: `from and to may cover at most ${MAX_REPORTS_RANGE_DAYS} days` };
  }
  return { ok: true, from, to };
}

/**
 * The payslip months a range touches. Payroll pays by the 25th–24th cycle and
 * files each cycle under the month it ends in: 25 Oct – 24 Nov is "Nov". So a
 * day on or after the 25th belongs to the next month's payslip.
 */
export function payslipMonthsFor(from: string, to: string): Array<{ month: number; year: number }> {
  const out: Array<{ month: number; year: number }> = [];
  const seen = new Set<string>();
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += 86_400_000) {
    const day = new Date(at);
    let month = day.getUTCMonth() + 1;
    let year = day.getUTCFullYear();
    if (day.getUTCDate() >= 25) {
      month += 1;
      if (month === 13) {
        month = 1;
        year += 1;
      }
    }
    const key = `${year}-${month}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ month, year });
    }
  }
  return out;
}

/** A DRF list, plain or paginated. */
function listOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const results = (data as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? (results as Record<string, unknown>[]) : [];
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in source) out[key] = source[key];
  return out;
}

const ATTENDANCE_FIELDS = [
  "id",
  "employee_id",
  "employee_name",
  "employee_status",
  "employee_role",
  "role",
  "branch",
  "email",
  "status",
  "intime",
  "outtime",
  "auto_closed_out",
] as const;

/** Every attendance record from `from` to `to`, the relieved included, as the Attendance page asks for them. */
export async function fetchAttendanceRecords(from: string, to: string): Promise<Record<string, unknown>[]> {
  const qs = new URLSearchParams({ start_date: from, end_date: to, with_relieved: "1" });
  const data = await payrollGet<unknown>(`/api/attendance/?${qs.toString()}`);
  return listOf(data).map((row) => pick(row, ATTENDANCE_FIELDS));
}

// The figures the Employee Pay Report prints, and what says whose slip it is.
const PAYSLIP_FIELDS = [
  "id",
  "employee",
  "month",
  "year",
  "status",
  "sent_at",
  "total_days",
  "paid_days",
  "absent_days",
  "half_days",
  "lop_days",
  "off_days",
  "casual_leave_used",
  "casual_leave_pay",
  "special_work_days",
  "special_work_pay",
  "gross_basic",
  "gross_hra",
  "gross_conveyance",
  "gross_child_edu",
  "gross_personal_allowance",
  "gross_incentive",
  "gross_other_earnings",
  "gross_salary",
  "earned_basic",
  "earned_hra",
  "earned_conveyance",
  "earned_child_edu",
  "earned_personal_allowance",
  "earned_incentive",
  "earned_other_earnings",
  "gross_earnings",
  "deduction_epf",
  "deduction_esi",
  "deduction_prof_tax",
  "deduction_lwf",
  "deduction_staff_advance",
  "deduction_tds",
  "deduction_other",
  "deduction_insurance",
  "gross_deductions",
  "employer_epf",
  "employer_esi",
  "employer_insurance",
  "petrol_allowance",
  "net_salary",
] as const;

const EMPLOYEE_FIELDS = ["id", "emp_code", "employee_name", "branch", "status"] as const;

/** The payslips of every month the range touches, relieved staff included, as the Employee Pay Report reads them. */
export async function fetchPayslips(from: string, to: string): Promise<Record<string, unknown>[]> {
  const months = payslipMonthsFor(from, to);
  const lists = await Promise.all(
    months.map(({ month, year }) => {
      const qs = new URLSearchParams({
        month: String(month),
        year: String(year),
        with_relieved: "1",
        with_day_counts: "1",
      });
      return payrollGet<unknown>(`/api/payslips/?${qs.toString()}`);
    }),
  );
  return lists.flatMap((data) =>
    listOf(data).map((row) => {
      const slim = pick(row, PAYSLIP_FIELDS);
      const employee = row.employee_details;
      slim.employee_details =
        employee && typeof employee === "object" ? pick(employee as Record<string, unknown>, EMPLOYEE_FIELDS) : null;
      return slim;
    }),
  );
}
