// READ-ONLY diagnostic for "Attended is 100 on the EOD but 75 in Engineer
// Productivity" (reported 2026-07-31).
//
// Neither number is miscalculated — they are two DIFFERENT definitions, and
// this script prints exactly which work orders each side counts and why.
//
//   EOD Attended (useKpiMetrics / the BOD & EOD table / the region Excel):
//     Morning is Scheduled OR an Engineer-Assigned variant  (isPlannedStatusValue)
//     AND Evening is non-blank and is NOT a planning status
//     -- no engineer required, and Customer Pending / Engineer Delay COUNT.
//
//   Productivity Attended (the shared Scheduled-gate model, 2026-07-23):
//     Morning is EXACTLY "Scheduled"                        (isScheduledStatus)
//     AND an engineer is set
//     AND the outcome is not CX_RESCHEDULE / ENGINEER_DELAY
//     -- a same-day closure counts even with a blank Evening.
//
// Every row in the gap is attributed to the FIRST reason that explains it, so
// the reason tally sums to the gap exactly.
//
// Usage (prod): node dist/scripts/diagnoseAttendedGap.js [YYYY-MM-DD] [ASP_CODE]
import {
  ASP_CODE_REGION_MAP,
  classifyProductivityStatus,
  isScheduledStatus,
  isProductivityVisibleRow,
  PRODUCTIVITY_MANUAL_PLACEHOLDER,
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
  previous_flex_status: string | null;
  change_type: string | null;
  same_day_closed: boolean;
}

function clean(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  return text === PRODUCTIVITY_MANUAL_PLACEHOLDER ? "" : text;
}

/** isPlannedStatusValue, mirrored from the frontend's reportUtils.ts. */
function isPlannedStatusValue(status: string | null | undefined): boolean {
  const s = String(status ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return (
    s === "scheduled" ||
    s === "engg assigned" ||
    s === "eng assigned" ||
    s === "engineer assigned"
  );
}

/** The EOD tile's Attended predicate, mirrored verbatim from useKpiMetrics.ts. */
function isEodAttended(row: PersistedRow): boolean {
  const morning = String(row.rtpl_status ?? "").trim();
  const evening = String(row.evening_rtpl_status ?? "").trim();
  return (
    isPlannedStatusValue(morning) &&
    evening !== "" &&
    evening.toLowerCase() !== "manual entry required" &&
    !isPlannedStatusValue(evening)
  );
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
    comparison: { previousFlexStatus: row.previous_flex_status },
  };
}

/** The productivity Attended predicate, using the REAL shared implementation. */
function isProductivityAttended(row: PersistedRow): boolean {
  const p = toProductivityRow(row);
  if (!isProductivityVisibleRow(p)) return false;
  if (!isScheduledStatus(clean(row.rtpl_status))) return false;
  if (clean(row.engineer) === "") return false;

  if (row.change_type === "CLOSED" || row.same_day_closed) return true;

  const evening = clean(row.evening_rtpl_status);
  if (!evening) return false;

  const bucket = classifyProductivityStatus(evening);
  return (
    bucket !== null &&
    bucket !== "SCHEDULED" &&
    bucket !== "CX_RESCHEDULE" &&
    bucket !== "ENGINEER_DELAY"
  );
}

/** First reason this row counts for EOD but not for Productivity. */
function gapReason(row: PersistedRow): string {
  const morning = clean(row.rtpl_status);
  if (!isScheduledStatus(morning)) {
    return `Morning is "${morning}", not exactly "Scheduled"`;
  }
  if (clean(row.engineer) === "") {
    return "no engineer set";
  }
  if (!isProductivityVisibleRow(toProductivityRow(row))) {
    return "off the Records page (old closure or Request-to-Cancel)";
  }
  const bucket = classifyProductivityStatus(clean(row.evening_rtpl_status));
  if (bucket === "CX_RESCHEDULE") return "Evening is Customer Pending (not attendance)";
  if (bucket === "ENGINEER_DELAY") return "Evening is Engineer Delay (not attendance)";
  return "unexplained — investigate";
}

async function run(): Promise<void> {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const aspFilter = (process.argv[3] ?? "").trim().toUpperCase();

  const client = await pool.connect();
  try {
    const latest = await client.query<{ report_id: string; created_at: string }>(
      `SELECT id AS report_id, created_at::TEXT
         FROM daily_call_plan_reports
        WHERE report_date = $1::date
        ORDER BY created_at DESC
        LIMIT 1`,
      [date],
    );
    const reportId = latest.rows[0]?.report_id;
    if (!reportId) {
      console.log(`No report for ${date}.`);
      return;
    }
    console.log(`\nReport for ${date} (generated ${latest.rows[0]?.created_at})`);
    if (aspFilter) console.log(`Filtered to ASP ${aspFilter}`);

    const result = await client.query<PersistedRow>(
      `SELECT serial_no, ticket_id, engineer, rtpl_status, evening_rtpl_status,
              work_location, flex_status, previous_flex_status,
              change_type::TEXT AS change_type, same_day_closed
         FROM daily_call_plan_report_rows
        WHERE report_id = $1
          AND NOT is_excluded
          AND ($2 = '' OR UPPER(TRIM(COALESCE(work_location, ''))) = $2)
        ORDER BY serial_no`,
      [reportId, aspFilter],
    );

    const rows = result.rows;
    const eod = rows.filter(isEodAttended);
    const prod = rows.filter(isProductivityAttended);
    const prodTickets = new Set(prod.map((r) => r.ticket_id));
    const eodTickets = new Set(eod.map((r) => r.ticket_id));

    const onlyEod = eod.filter((r) => !prodTickets.has(r.ticket_id));
    const onlyProd = prod.filter((r) => !eodTickets.has(r.ticket_id));

    console.log(`\nEOD Attended          : ${eod.length}`);
    console.log(`Productivity Attended : ${prod.length}`);
    console.log(`Counted by EOD only   : ${onlyEod.length}`);
    console.log(`Counted by Prod only  : ${onlyProd.length}`);

    const byReason = new Map<string, PersistedRow[]>();
    for (const row of onlyEod) {
      const reason = gapReason(row);
      const list = byReason.get(reason) ?? [];
      list.push(row);
      byReason.set(reason, list);
    }

    console.log(`\n--- Counted by the EOD tile but NOT by Productivity ---`);
    for (const [reason, list] of [...byReason.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    )) {
      console.log(`\n  ${list.length}x  ${reason}`);
      for (const row of list) {
        const asp = String(row.work_location ?? "").trim().toUpperCase();
        console.log(
          `      ${row.ticket_id}  [${ASP_CODE_REGION_MAP[asp] ?? (asp || "?")}]` +
            `  engineer="${row.engineer ?? ""}"` +
            `  morning="${row.rtpl_status ?? ""}"` +
            `  evening="${row.evening_rtpl_status ?? ""}"`,
        );
      }
    }

    if (onlyProd.length > 0) {
      console.log(`\n--- Counted by Productivity but NOT by the EOD tile ---`);
      for (const row of onlyProd) {
        const why =
          row.change_type === "CLOSED" || row.same_day_closed
            ? "closed today with no Evening entry"
            : "see status columns";
        console.log(
          `      ${row.ticket_id}  ${why}` +
            `  morning="${row.rtpl_status ?? ""}"` +
            `  evening="${row.evening_rtpl_status ?? ""}"`,
        );
      }
    }

    console.log(
      `\nNothing was changed. Decide which definition should win, then the` +
        ` losing side gets pointed at the shared implementation.\n`,
    );
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
