// READ-ONLY diagnostic for wrong engineer-productivity numbers on a given day
// (the 2026-07-23 "other regions show Assigned = Attended = Closed" report).
//
// Two independent failure modes look identical in the UI and this script tells
// them apart:
//   A. FROZEN SNAPSHOT — the region was Final-EOD-closed BEFORE the
//      Scheduled-gate deploy, so its table renders numbers frozen under the
//      old logic. Fix: SUPER_ADMIN reopen + re-close; nothing is wrong in the
//      data.
//   B. MASS SAME-DAY CLOSE — the newest Flex upload did not contain a region's
//      tickets, so its booked calls all became same-day-closed synthetic rows
//      and productivity honestly reports them as Closed. Fix: re-upload with
//      full coverage and regenerate (the 2026-07-18 Vellore runbook).
//
// Prints, for the given working date (default: today, server time):
//   1. Region EOD states + each frozen snapshot's per-engineer numbers.
//   2. Reports & completed sessions for the date (which one the app opens).
//   3. Per-region row profile of the latest report: booked rows, booked rows
//      closed by change_type/same-day, blank evenings — mass-close jumps out.
//   4. Live per-engineer productivity recomputed HERE with the CURRENT shared
//      logic from the persisted rows — diff anything the UI shows against
//      this; a closed region whose frozen numbers differ is failure mode A.
//   5. Per-work-location row counts of the newest FLEX uploads — a region
//      missing from the newest file is failure mode B.
//
// Usage (prod): node dist/scripts/diagnoseEngineerProductivityDay.js [YYYY-MM-DD]
import {
  ASP_CODE_REGION_MAP,
  classifyProductivityStatus,
  computeEngineerProductivity,
  type ProductivityReportRow,
} from "@opencall/shared";
import { closeDatabasePool, pool } from "../config/database.js";

interface PersistedRow {
  serial_no: number;
  ticket_id: string;
  engineer: string | null;
  rtpl_status: string | null;
  evening_rtpl_status: string | null;
  work_location: string | null;
  flex_status: string | null;
  change_type: string | null;
  same_day_closed: boolean;
}

function regionLabel(aspCode: string): string {
  const code = aspCode.trim().toUpperCase();
  return `${ASP_CODE_REGION_MAP[code] ?? "?"} (${code || "blank"})`;
}

function toProductivityRow(row: PersistedRow): ProductivityReportRow {
  return {
    serialNo: row.serial_no,
    output: {
      "Ticket ID": row.ticket_id,
      Engineer: row.engineer ?? "",
      "RTPL status": row.rtpl_status ?? "",
      "Evening status": row.evening_rtpl_status ?? "",
      "Work Location": row.work_location ?? "",
      "Flex Status": row.flex_status ?? "",
    },
    carryForward: {
      closedSyntheticRow: row.change_type === "CLOSED",
      sameDayClosedRow: row.same_day_closed,
    },
    comparison: null,
  };
}

async function run(): Promise<void> {
  const dateArg = process.argv[2];
  const date =
    dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg)
      ? dateArg
      : new Date().toISOString().slice(0, 10);

  const client = await pool.connect();
  try {
    console.log("=== diagnoseEngineerProductivityDay ===");
    console.log("working date:", date);

    // 1. Region EOD state + frozen snapshot summaries.
    const eodStates = await client.query(
      `
        SELECT
          regions.code,
          regions.name,
          state.status,
          state.closed_at::TEXT AS closed_at,
          COALESCE(users.email, users.username) AS closed_by
        FROM region_eod_state state
        JOIN regions ON regions.id = state.region_id
        LEFT JOIN users ON users.id = state.closed_by
        WHERE state.working_date = $1::date
        ORDER BY regions.code
      `,
      [date],
    );
    console.log("\n--- 1. Region EOD state (CLOSED regions render their FROZEN snapshot, not live data) ---");
    console.table(eodStates.rows);

    const snapshots = await client.query<{
      code: string;
      payload: {
        list?: Array<{
          name: string;
          assigned: number;
          attended: number;
          closed: number;
          partOrdered: number;
          underObservation: number;
          cxReschedule: number;
          engineerDelay: number;
        }>;
      };
    }>(
      `
        SELECT regions.code, snapshot.payload
        FROM region_productivity_snapshot snapshot
        JOIN regions ON regions.id = snapshot.region_id
        WHERE snapshot.working_date = $1::date
        ORDER BY regions.code
      `,
      [date],
    );
    for (const snap of snapshots.rows) {
      console.log(`\nFROZEN snapshot — region ${snap.code} (computed with whatever logic ran at close time):`);
      console.table(
        (snap.payload.list ?? []).map((e) => ({
          engineer: e.name,
          assigned: e.assigned,
          attended: e.attended,
          closed: e.closed,
          partOrdered: e.partOrdered,
          underObs: e.underObservation,
          cx: e.cxReschedule,
          delay: e.engineerDelay,
        })),
      );
    }

    // 2. Reports & completed sessions for the date.
    const sessions = await client.query<{
      report_id: string;
      session_updated_at: string | null;
      session_status: string | null;
      persisted_rows: string;
    }>(
      `
        SELECT
          reports.id                 AS report_id,
          reports.region_id          AS report_region_id,
          sessions.status            AS session_status,
          sessions.updated_at::TEXT  AS session_updated_at,
          (SELECT COUNT(*) FROM daily_call_plan_report_rows r
            WHERE r.report_id = reports.id) AS persisted_rows
        FROM daily_call_plan_reports reports
        LEFT JOIN report_history_sessions sessions
          ON sessions.daily_call_plan_report_id = reports.id
        WHERE reports.report_date = $1::date
        ORDER BY sessions.updated_at DESC NULLS LAST
      `,
      [date],
    );
    console.log("\n--- 2. Reports & sessions for the date (first COMPLETED row = what the app opens) ---");
    console.table(sessions.rows);

    const latest = sessions.rows.find((s) => s.session_status === "COMPLETED") ?? sessions.rows[0];
    if (!latest) {
      console.log("No report found for this date — nothing more to analyse.");
      return;
    }

    // Persisted rows of the report the app opens.
    const rowsResult = await client.query<PersistedRow>(
      `
        SELECT
          serial_no, ticket_id, engineer, rtpl_status, evening_rtpl_status,
          work_location, flex_status, change_type::TEXT AS change_type,
          same_day_closed
        FROM daily_call_plan_report_rows
        WHERE report_id = $1 AND NOT is_excluded
        ORDER BY serial_no
      `,
      [latest.report_id],
    );
    const rows = rowsResult.rows;

    // 3. Per-region profile: booked vs booked-but-closed.
    console.log("\n--- 3. Per-region row profile of that report ---");
    const byRegion = new Map<string, PersistedRow[]>();
    for (const row of rows) {
      const key = (row.work_location ?? "").trim().toUpperCase();
      const list = byRegion.get(key) ?? [];
      list.push(row);
      byRegion.set(key, list);
    }
    console.table(
      Array.from(byRegion.entries()).map(([asp, regionRows]) => {
        const booked = regionRows.filter(
          (r) =>
            classifyProductivityStatus(r.rtpl_status ?? "") === "SCHEDULED" &&
            (r.engineer ?? "").trim() !== "" &&
            (r.engineer ?? "").trim() !== "Manual Entry Required",
        );
        const bookedClosedRows = booked.filter(
          (r) => r.change_type === "CLOSED" || r.same_day_closed,
        );
        return {
          region: regionLabel(asp),
          rows: regionRows.length,
          rowsClosed: regionRows.filter((r) => r.change_type === "CLOSED").length,
          rowsSameDayClosed: regionRows.filter((r) => r.same_day_closed).length,
          booked: booked.length,
          bookedClosed: bookedClosedRows.length,
          bookedBlankEvening: booked.filter(
            (r) => !(r.evening_rtpl_status ?? "").trim(),
          ).length,
        };
      }),
    );
    console.log("bookedClosed ≈ booked for a whole region = mass same-day close (failure mode B).");

    // 4. Live productivity recomputed with the CURRENT shared logic.
    console.log("\n--- 4. Per-engineer productivity recomputed NOW from those rows (current deployed logic) ---");
    const live = computeEngineerProductivity(rows.map(toProductivityRow));
    console.table(
      live.list.map((e) => ({
        engineer: e.name,
        region: e.regionName,
        assigned: e.assigned,
        attended: e.attended,
        closed: e.closed,
        partOrdered: e.partOrdered,
        underObs: e.underObservation,
        cx: e.cxReschedule,
        delay: e.engineerDelay,
      })),
    );
    console.log(`total attended (live recompute): ${live.totalAttended}`);
    console.log("A CLOSED region whose frozen table (section 1) differs from this = stale snapshot (failure mode A): reopen + re-close it.");

    // 5. Region coverage of the newest FLEX uploads.
    const coverage = await client.query(
      `
        SELECT
          b.created_at::TEXT AS uploaded_at,
          b.original_file_name,
          b.region_id,
          UPPER(TRIM(f.work_location)) AS work_location,
          COUNT(*) AS rows
        FROM flex_wip_records f
        JOIN source_upload_batches b ON b.id = f.upload_batch_id
        WHERE b.source_type = 'FLEX_WIP'
          AND b.created_at > NOW() - INTERVAL '2 days'
        GROUP BY b.id, b.created_at, b.original_file_name, b.region_id, UPPER(TRIM(f.work_location))
        ORDER BY b.created_at DESC, work_location
      `,
    );
    console.log("\n--- 5. Work-location coverage of FLEX uploads, last 2 days ---");
    console.table(coverage.rows);
    console.log("A region present in earlier files but missing from the newest full upload = its calls were mass-closed (failure mode B): re-upload full coverage, regenerate, reopen+re-close any region frozen in that window.");
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
