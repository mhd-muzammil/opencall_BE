// READ-ONLY diagnostic for "Closed Calls is 55 on the BOD/EOD table but 53 in
// Engineer Productivity" (reported 2026-08-06 for 05-08-2026).
//
// Neither number is miscalculated — they are two DIFFERENT definitions, and
// this script prints exactly which work orders each side counts and why. It is
// the closed-call sibling of diagnoseAttendedGap.ts.
//
//   BOD/EOD "Closed Calls" (RTPLAnalytics caseClosedRows):
//     an Evening status containing "case close"/"wo close"
//     OR the row vanished from the day's Flex file (a closed synthetic row)
//        and was NOT a cancellation
//     -- no engineer required, and the Morning status is never consulted.
//
//   Productivity "Closed" (the shared Scheduled-gate model, 2026-07-23):
//     Morning is EXACTLY "Scheduled" AND an engineer is set
//     AND the row is productivity-visible
//     AND its day-scoped bucket is CLOSED.
//
// So the gap is closures that were never BOOKED: the call closed, but it was
// not part of the day's plan. That is by design (product-owner decision
// 2026-07-23) — this script names the specific work orders so the decision can
// be checked against reality.
//
// Every row in the gap is attributed to the FIRST reason that explains it, so
// the reason tally sums to the gap exactly.
//
// Usage (prod): node dist/scripts/diagnoseClosedGap.js [YYYY-MM-DD] [ASP_CODE]
import {
  ASP_CODE_REGION_MAP,
  isScheduledStatus,
  isProductivityVisibleRow,
  resolveDayScopedProductivityBucket,
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

function normalize(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** isCaseClosedStatusValue, mirrored from the frontend's reportUtils.ts. */
function isCaseClosedStatusValue(status: string | null | undefined): boolean {
  const s = normalize(status);
  return s.includes("case close") || s.includes("wo close");
}

/**
 * Whether a vanished row was a cancellation rather than a completed close.
 *
 * APPROXIMATION: the browser tests the serve-time closure overlay ("Flex Status
 * (WIP)" present -> trust Flex's verdict), which does not exist on the stored
 * row. Here the persisted Flex status is used when it states an outcome, with
 * our own status column as the fallback — the same two signals in the same
 * order. A row where the overlay would disagree with both is possible but rare;
 * it would show up as "unexplained" rather than being silently absorbed.
 */
function wasCancelled(row: PersistedRow): boolean {
  const flex = String(row.flex_status ?? "").toUpperCase();
  if (flex.includes("CANCEL")) return true;
  if (flex.includes("CLOSE")) return false;
  return (
    normalize(row.evening_rtpl_status).includes("cancel") ||
    normalize(row.rtpl_status).includes("cancel")
  );
}

/** The BOD/EOD table's Closed Calls predicate. */
function isEodClosed(row: PersistedRow): boolean {
  if (row.change_type === "CLOSED") {
    return !wasCancelled(row);
  }
  return isCaseClosedStatusValue(row.evening_rtpl_status);
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

/** The productivity Closed predicate, using the REAL shared implementation. */
function isProductivityClosed(row: PersistedRow): boolean {
  return resolveDayScopedProductivityBucket(toProductivityRow(row)) === "CLOSED";
}

/** First reason this row counts for the BOD/EOD table but not for Productivity. */
function gapReason(row: PersistedRow): string {
  const morning = clean(row.rtpl_status);
  if (!isScheduledStatus(morning)) {
    return morning === ""
      ? "no Morning status — the call was never booked"
      : `Morning is "${morning}", not exactly "Scheduled" — not in the day's plan`;
  }
  if (clean(row.engineer) === "") {
    return "no engineer set — booked but unassigned";
  }
  if (!isProductivityVisibleRow(toProductivityRow(row))) {
    return "off the Records page (old closure or Request-to-Cancel)";
  }
  const bucket = resolveDayScopedProductivityBucket(toProductivityRow(row));
  if (bucket !== "CLOSED") {
    return `productivity bucket is ${bucket ?? "none"}, not CLOSED`;
  }
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
    const eod = rows.filter(isEodClosed);
    const prod = rows.filter(isProductivityClosed);
    const prodTickets = new Set(prod.map((r) => r.ticket_id));
    const eodTickets = new Set(eod.map((r) => r.ticket_id));

    const onlyEod = eod.filter((r) => !prodTickets.has(r.ticket_id));
    const onlyProd = prod.filter((r) => !eodTickets.has(r.ticket_id));

    console.log(`\nBOD/EOD Closed Calls  : ${eod.length}`);
    console.log(`Productivity Closed   : ${prod.length}`);
    console.log(`Counted by EOD only   : ${onlyEod.length}`);
    console.log(`Counted by Prod only  : ${onlyProd.length}`);

    const byReason = new Map<string, PersistedRow[]>();
    for (const row of onlyEod) {
      const reason = gapReason(row);
      const list = byReason.get(reason) ?? [];
      list.push(row);
      byReason.set(reason, list);
    }

    console.log(`\n--- Counted by the BOD/EOD table but NOT by Productivity ---`);
    if (onlyEod.length === 0) {
      console.log("  (none)");
    }
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
            `  evening="${row.evening_rtpl_status ?? ""}"` +
            `  flex="${row.flex_status ?? ""}"` +
            `  vanished=${row.change_type === "CLOSED"}`,
        );
      }
    }

    if (onlyProd.length > 0) {
      console.log(`\n--- Counted by Productivity but NOT by the BOD/EOD table ---`);
      for (const row of onlyProd) {
        console.log(
          `      ${row.ticket_id}` +
            `  morning="${row.rtpl_status ?? ""}"` +
            `  evening="${row.evening_rtpl_status ?? ""}"` +
            `  flex="${row.flex_status ?? ""}"` +
            `  sameDayClosed=${row.same_day_closed}`,
        );
      }
    }

    console.log(
      `\nNothing was changed. The gap is closures outside the day's plan —` +
        ` expected by the Scheduled-gate model, but the tickets above are the` +
        ` ones to check if that is not what you meant.\n`,
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
