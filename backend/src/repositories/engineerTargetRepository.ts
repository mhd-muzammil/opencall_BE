import { query } from "../config/database.js";

/**
 * Reads for the Engineer Target view. Strictly READ-ONLY and self-contained: it finds the
 * report days inside a date range so the service can replay each one through the SHARED
 * engineer-productivity calculation.
 *
 * Deliberately a new repository rather than an addition to
 * `dailyCallPlanReportRepository`: this feature must not modify any existing file.
 *
 * NOTE on the source of truth: `region_productivity_snapshot` only holds days a region has
 * explicitly Final-EOD closed, so it is empty on any deployment that does not use that
 * button and cannot back a month-to-date view. The daily reports themselves always exist,
 * so the range is built from those.
 */

export interface ReportDayRef {
  reportId: string;
  reportDate: string;
}

/**
 * One report per calendar date in [fromIso, toIso], newest report wins for a date.
 *
 * A date can have several reports (a re-generate makes a new one); the most recently
 * created is the one the dashboards show, so it is the one replayed here.
 */
export async function findReportDaysInRange(
  fromIso: string,
  toIso: string,
): Promise<ReportDayRef[]> {
  const result = await query<{ report_id: string; report_date: string }>(
    `
      SELECT DISTINCT ON (report_date)
        id::TEXT          AS report_id,
        report_date::TEXT AS report_date
      FROM daily_call_plan_reports
      WHERE report_date >= $1::DATE
        AND report_date <= $2::DATE
      ORDER BY report_date DESC, created_at DESC, id DESC
    `,
    [fromIso, toIso],
  );

  return result.rows.map((row) => ({
    reportId: row.report_id,
    reportDate: row.report_date,
  }));
}
