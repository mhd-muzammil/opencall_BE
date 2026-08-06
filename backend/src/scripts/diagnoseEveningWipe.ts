// READ-ONLY diagnostic for "the Evening status I just saved goes blank again
// within a minute" (reported 2026-08-06, worst on special-access logins).
//
// A special-access session re-runs a FULL report regeneration every 60s, so any
// gap in the Evening merge shows up there ~60x more often than for an admin.
// The merge has several moving parts and they are hard to tell apart from the
// symptom alone. This prints the state each one actually sees, so the failing
// link is named rather than guessed:
//
//   1. Every report of the day that holds this ticket, with its Evening value,
//      whether the row counts as user-edited (updated_at stamped), and both
//      timestamps the merge compares.
//   2. Which row the same-day Evening AUTHORITY would elect — the query that is
//      supposed to make a user-set Evening survive every later regeneration.
//   3. Which report the special-access endpoint currently serves, and what that
//      report's own persisted row says.
//
// Read it top-down: if the authority elects the right row but the served report
// still shows blank, the fault is in the merge; if no row qualifies for the
// authority, the fault is in the save (an Evening saved without updated_at, or
// saved onto a report from a different day).
//
// Usage (prod):
//   node dist/scripts/diagnoseEveningWipe.js <TICKET_ID> [YYYY-MM-DD]
import { closeDatabasePool, pool } from "../config/database.js";

interface DayRow {
  report_id: string;
  report_date: string;
  report_created_at: string;
  session_id: string | null;
  session_created_at: string | null;
  row_id: string;
  evening_rtpl_status: string | null;
  rtpl_status: string | null;
  updated_at: string | null;
  evening_updated_at: string | null;
  authority_clock: string | null;
  updated_by: string | null;
  updated_by_special_access: string | null;
  is_excluded: boolean;
  qualifies_for_authority: boolean;
}

function show(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  return text === "" ? "(blank)" : text;
}

async function run(): Promise<void> {
  const ticketId = (process.argv[2] ?? "").trim();
  const date = process.argv[3] ?? new Date().toISOString().slice(0, 10);

  if (!ticketId) {
    console.log(
      "Usage: node dist/scripts/diagnoseEveningWipe.js <TICKET_ID> [YYYY-MM-DD]",
    );
    return;
  }

  const client = await pool.connect();
  try {
    console.log(`\nTicket ${ticketId} on ${date}\n`);

    // Every row for this ticket across ALL of the day's reports. The flags
    // mirror the authority query's own WHERE clause exactly, so a row that
    // "looks edited" but does not qualify is visible as such.
    const rows = await client.query<DayRow>(
      `
        SELECT
          reports.id::TEXT           AS report_id,
          reports.report_date::TEXT  AS report_date,
          reports.created_at::TEXT   AS report_created_at,
          sessions.id::TEXT          AS session_id,
          sessions.created_at::TEXT  AS session_created_at,
          rows.id::TEXT              AS row_id,
          rows.evening_rtpl_status,
          rows.rtpl_status,
          rows.updated_at::TEXT      AS updated_at,
          rows.evening_rtpl_status_updated_at::TEXT AS evening_updated_at,
          COALESCE(rows.evening_rtpl_status_updated_at, rows.updated_at)::TEXT
                                     AS authority_clock,
          rows.updated_by::TEXT      AS updated_by,
          rows.updated_by_special_access::TEXT AS updated_by_special_access,
          rows.is_excluded,
          (
            rows.updated_at IS NOT NULL
            AND NOT rows.is_excluded
            AND NULLIF(TRIM(COALESCE(rows.evening_rtpl_status, '')), '') IS NOT NULL
          )                          AS qualifies_for_authority
        FROM daily_call_plan_report_rows rows
        JOIN daily_call_plan_reports reports ON reports.id = rows.report_id
        LEFT JOIN report_history_sessions sessions
          ON sessions.daily_call_plan_report_id = reports.id
         AND sessions.status = 'COMPLETED'
        WHERE reports.report_date = $1::date
          AND UPPER(TRIM(rows.ticket_id)) = UPPER(TRIM($2))
        ORDER BY reports.created_at ASC
      `,
      [date, ticketId],
    );

    if (rows.rows.length === 0) {
      console.log("No row for that ticket on that date — check the ticket id.");
      return;
    }

    console.log(`--- Every report of ${date} holding this ticket ---`);
    for (const row of rows.rows) {
      console.log(
        `\n  report ${row.report_id.slice(0, 8)}  created ${row.report_created_at}`,
      );
      console.log(`      row ${row.row_id.slice(0, 8)}  excluded=${row.is_excluded}`);
      console.log(`      Morning        : ${show(row.rtpl_status)}`);
      console.log(`      EVENING        : ${show(row.evening_rtpl_status)}`);
      console.log(`      updated_at     : ${row.updated_at ?? "(never edited)"}`);
      console.log(`      evening edited : ${row.evening_updated_at ?? "(null)"}`);
      console.log(`      authority clock: ${row.authority_clock ?? "(null)"}`);
      console.log(
        `      edited by      : user=${row.updated_by ?? "-"} special=${row.updated_by_special_access ?? "-"}`,
      );
      console.log(
        `      counts for authority: ${row.qualifies_for_authority ? "YES" : "no"}`,
      );
    }

    // 2. The authority's own election, reproduced verbatim.
    const authority = await client.query<{
      row_id: string;
      evening_rtpl_status: string;
      evening_updated_at: string;
    }>(
      `
        SELECT
          rows.id::TEXT AS row_id,
          rows.evening_rtpl_status,
          COALESCE(rows.evening_rtpl_status_updated_at, rows.updated_at)::TEXT
            AS evening_updated_at
        FROM daily_call_plan_report_rows rows
        JOIN daily_call_plan_reports reports ON reports.id = rows.report_id
        WHERE reports.report_date = $1::date
          AND UPPER(TRIM(rows.ticket_id)) = UPPER(TRIM($2))
          AND rows.updated_at IS NOT NULL
          AND NOT rows.is_excluded
          AND NULLIF(TRIM(COALESCE(rows.evening_rtpl_status, '')), '') IS NOT NULL
        ORDER BY COALESCE(rows.evening_rtpl_status_updated_at, rows.updated_at) DESC,
                 rows.id DESC
        LIMIT 1
      `,
      [date, ticketId],
    );

    console.log(`\n--- Same-day Evening authority ---`);
    if (authority.rows.length === 0) {
      console.log(
        "  NOTHING QUALIFIES. No regeneration can restore an Evening for this\n" +
          "  ticket — every later report will show it blank. The save is the\n" +
          "  suspect: an Evening saved without stamping updated_at, saved onto a\n" +
          "  report of a different date, or cleared again after saving.",
      );
    } else {
      const elected = authority.rows[0];
      console.log(
        `  elects row ${elected?.row_id.slice(0, 8)} -> "${show(elected?.evening_rtpl_status)}"` +
          ` (edited ${elected?.evening_updated_at})`,
      );
    }

    // 3. The report a special-access session is actually served right now.
    const served = await client.query<{ report_id: string; created_at: string }>(
      `
        SELECT reports.id::TEXT AS report_id, sessions.created_at::TEXT
        FROM report_history_sessions sessions
        JOIN daily_call_plan_reports reports
          ON reports.id = sessions.daily_call_plan_report_id
        WHERE sessions.status = 'COMPLETED'
          AND sessions.flex_upload_batch_id IS NOT NULL
          AND reports.report_date = $1::date
        ORDER BY reports.report_date DESC NULLS LAST, sessions.created_at DESC
        LIMIT 1
      `,
      [date],
    );

    const servedId = served.rows[0]?.report_id;
    console.log(`\n--- The report a special-access poll serves ---`);
    if (!servedId) {
      console.log("  none found for this date");
    } else {
      const servedRow = rows.rows.find((row) => row.report_id === servedId);
      console.log(`  report ${servedId.slice(0, 8)} (session ${served.rows[0]?.created_at})`);
      console.log(
        `  its own persisted Evening: ${servedRow ? show(servedRow.evening_rtpl_status) : "(ticket absent from this report)"}`,
      );
      if (servedRow && !show(servedRow.evening_rtpl_status).localeCompare("(blank)")) {
        console.log(
          "  -> blank on the served report, so the grid depends entirely on the\n" +
            "     authority heal above. If the authority elected a value and the\n" +
            "     screen still shows blank, the heal is the failing link.",
        );
      }
    }

    console.log("\nNothing was changed.\n");
  } finally {
    client.release();
  }
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabasePool();
  });
