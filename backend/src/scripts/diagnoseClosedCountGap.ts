// READ-ONLY diagnostic: "the green Closed Calls number and the FieldEZ data
// closure number disagree — which calls are the difference?"
//
// Both numbers count COMPLETED closures over the same date range, and both
// classify the vendor's status with the same rule, so a gap between them is
// never a classification disagreement. It is always a SET difference, and this
// script names the calls in it.
//
// The two sides:
//
//   OUR LEDGER (the big green number, minus cancellations)
//     Rows of ONE report (the newest, unless a report id is given) that are
//     closed synthetic rows, matched to a stored closure the way the serve-time
//     overlay matches them — WO id first, then Case id — and kept when that
//     closure's date falls in the range and its status reads as completed.
//     `Case Closed Date` on the row IS the closure's own date (the overlay
//     stamps it), which is why a date mismatch cannot explain a gap.
//
//   FIELDEZ (the "FieldEZ data closure" line)
//     Stored closures whose date falls in the range and whose status reads as
//     completed. One row per work order — the import collapses the per-part-order
//     rows of the source workbook.
//
// Every call is put in exactly one class:
//
//   DUPLICATE_LEDGER_ROW  – two or more report rows resolved to the SAME stored
//                           closure, so our side counts it twice and FieldEZ
//                           once. The usual cause of our number being higher:
//                           one row matches by WO id, another by Case id.
//   NOT_IN_FIELDEZ        – a closed row whose closure is not in FieldEZ's set
//                           for this range.
//   NO_CLOSURE_RECORD     – a closed row with no stored closure at all. It has
//                           no Flex Status overlay, so the card counts it under
//                           neither closed nor cancelled — it is the card's
//                           "unknown" remainder.
//   NOT_IN_LEDGER         – a FieldEZ closure with no closed row in this report.
//                           Makes FieldEZ the higher number.
//
// Cancellations are reported separately and never mixed in: only completed
// closures are billable, which is the whole reason the two numbers are read
// against each other.
//
// Usage (local): pnpm tsx src/scripts/diagnoseClosedCountGap.ts <from> <to> [asp] [report-id]
// Usage (prod):  node dist/scripts/diagnoseClosedCountGap.js <from> <to> [asp] [report-id]
//   <from>/<to>  YYYY-MM-DD, inclusive, matching the page's period filter
//   [asp]        ASPS01461 etc, or "ALL" (default)
//   [report-id]  defaults to the newest report, which is what the page loads
import { closeDatabasePool, query } from "../config/database.js";
import { classifyClosureStatus } from "../services/closureDates/closureStatusClassify.js";
import { normalizeKey } from "../repositories/caseClosureDateRepository.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface ClosureRecord {
  woId: string;
  caseId: string;
  aspCode: string;
  status: string;
  closedOn: string;
  /** Identity of the stored closure, for spotting two rows claiming one closure. */
  key: string;
}

interface LedgerRow {
  rowId: string;
  ticketId: string;
  caseId: string;
  aspCode: string;
}

function classify(status: string): "closed" | "cancelled" | "other" {
  return classifyClosureStatus(status);
}

async function loadClosures(): Promise<ClosureRecord[]> {
  const result = await query<{
    wo_id: string;
    case_id: string;
    work_location: string | null;
    closure_status: string | null;
    closed_on: string | null;
  }>(
    `SELECT wo_id,
            case_id,
            work_location,
            closure_status,
            to_char(closed_on, 'YYYY-MM-DD') AS closed_on
       FROM case_closure_dates`,
  );
  return result.rows.map((row) => ({
    woId: row.wo_id,
    caseId: row.case_id,
    aspCode: String(row.work_location ?? "").trim().toUpperCase(),
    status: row.closure_status ?? "",
    closedOn: row.closed_on ?? "",
    // wo_id is the import's primary key; case_id only identifies a closure that
    // arrived without one.
    key: row.wo_id || `CASE:${row.case_id}`,
  }));
}

async function resolveReportId(explicit: string | undefined): Promise<{
  reportId: string;
  reportDate: string;
}> {
  if (explicit) {
    const result = await query<{ id: string; report_date: string }>(
      `SELECT id, to_char(report_date, 'YYYY-MM-DD') AS report_date
         FROM daily_call_plan_reports WHERE id = $1`,
      [explicit],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`No report with id ${explicit}`);
    return { reportId: row.id, reportDate: row.report_date };
  }
  const result = await query<{ id: string; report_date: string }>(
    `SELECT id, to_char(report_date, 'YYYY-MM-DD') AS report_date
       FROM daily_call_plan_reports
      ORDER BY report_date DESC, created_at DESC
      LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("No reports stored");
  return { reportId: row.id, reportDate: row.report_date };
}

async function loadClosedLedgerRows(reportId: string): Promise<LedgerRow[]> {
  const result = await query<{
    id: string;
    ticket_id: string | null;
    case_id: string | null;
    work_location: string | null;
  }>(
    `SELECT id, ticket_id, case_id, work_location
       FROM daily_call_plan_report_rows
      WHERE report_id = $1
        AND NOT is_excluded
        AND change_type = 'CLOSED'`,
    [reportId],
  );
  return result.rows.map((row) => ({
    rowId: row.id,
    ticketId: row.ticket_id ?? "",
    caseId: row.case_id ?? "",
    aspCode: String(row.work_location ?? "").trim().toUpperCase(),
  }));
}

function table(rows: ReadonlyArray<Record<string, string>>, limit = 60): void {
  if (rows.length === 0) {
    console.log("  (none)");
    return;
  }
  const shown = rows.slice(0, limit);
  const headers = Object.keys(shown[0]!);
  const width = headers.map((h) =>
    Math.max(h.length, ...shown.map((r) => String(r[h] ?? "").length)),
  );
  const line = (cells: string[]) =>
    "  " + cells.map((c, i) => c.padEnd(width[i]!)).join("  ");
  console.log(line(headers));
  console.log("  " + width.map((w) => "-".repeat(w)).join("  "));
  for (const row of shown) {
    console.log(line(headers.map((h) => String(row[h] ?? ""))));
  }
  if (rows.length > shown.length) {
    console.log(`  ... and ${rows.length - shown.length} more`);
  }
}

async function main(): Promise<void> {
  const [from, to, aspArg, reportArg] = process.argv.slice(2);
  if (!from || !to || !DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) {
    console.error(
      "Usage: diagnoseClosedCountGap <from YYYY-MM-DD> <to YYYY-MM-DD> [ASP|ALL] [report-id]",
    );
    process.exitCode = 1;
    return;
  }
  const asp = String(aspArg ?? "ALL").trim().toUpperCase();
  const aspFilter = asp === "ALL" || asp === "" ? null : asp;

  const { reportId, reportDate } = await resolveReportId(reportArg);
  const [closures, ledgerRows] = await Promise.all([
    loadClosures(),
    loadClosedLedgerRows(reportId),
  ]);

  console.log(`Report      ${reportId} (${reportDate})`);
  console.log(`Range       ${from} .. ${to}`);
  console.log(`Region      ${aspFilter ?? "ALL"}`);
  console.log("");

  // The overlay's lookup, rebuilt exactly: WO id first, then Case id.
  const byWo = new Map<string, ClosureRecord>();
  const byCase = new Map<string, ClosureRecord>();
  for (const closure of closures) {
    if (closure.woId) byWo.set(normalizeKey(closure.woId), closure);
    if (closure.caseId) byCase.set(normalizeKey(closure.caseId), closure);
  }

  const inRange = (closure: ClosureRecord) =>
    closure.closedOn !== "" &&
    closure.closedOn >= from &&
    closure.closedOn <= to;

  // ---- FieldEZ side: stored closures, completed only, in range and region.
  const fieldezClosed = closures.filter(
    (c) =>
      inRange(c) &&
      classify(c.status) === "closed" &&
      (!aspFilter || c.aspCode === aspFilter),
  );
  const fieldezCancelled = closures.filter(
    (c) =>
      inRange(c) &&
      classify(c.status) === "cancelled" &&
      (!aspFilter || c.aspCode === aspFilter),
  );

  // ---- Our side: closed rows of the report, resolved through the same overlay.
  const claims = new Map<string, LedgerRow[]>();
  const noClosureRecord: LedgerRow[] = [];
  let ourClosed = 0;
  let ourCancelled = 0;

  for (const row of ledgerRows) {
    if (aspFilter && row.aspCode !== aspFilter) continue;
    const closure =
      byWo.get(normalizeKey(row.ticketId)) ??
      byCase.get(normalizeKey(row.caseId)) ??
      null;
    if (!closure) {
      noClosureRecord.push(row);
      continue;
    }
    if (!inRange(closure)) continue;
    const group = classify(closure.status);
    if (group === "closed") ourClosed += 1;
    else if (group === "cancelled") ourCancelled += 1;
    else continue;
    const existing = claims.get(closure.key);
    if (existing) existing.push(row);
    else claims.set(closure.key, [row]);
  }

  console.log("COMPLETED CLOSURES (the billable number)");
  console.log(`  our ledger    ${ourClosed}`);
  console.log(`  FieldEZ       ${fieldezClosed.length}`);
  console.log(`  difference    ${ourClosed - fieldezClosed.length}`);
  console.log("");
  console.log("CANCELLED (not billable, shown for completeness)");
  console.log(`  our ledger    ${ourCancelled}`);
  console.log(`  FieldEZ       ${fieldezCancelled.length}`);
  console.log(`  difference    ${ourCancelled - fieldezCancelled.length}`);
  console.log("");

  const closureByKey = new Map(closures.map((c) => [c.key, c]));

  // ---- DUPLICATE_LEDGER_ROW: one stored closure, several report rows.
  const duplicates: Array<Record<string, string>> = [];
  for (const [key, rows] of claims) {
    if (rows.length < 2) continue;
    const closure = closureByKey.get(key);
    if (!closure || classify(closure.status) !== "closed") continue;
    for (const row of rows) {
      duplicates.push({
        Closure: key,
        "Row Ticket": row.ticketId || "-",
        "Row Case": row.caseId || "-",
        Region: row.aspCode || "-",
        Closed: closure.closedOn,
        Status: closure.status,
        Extra: String(rows.length - 1),
      });
    }
  }
  console.log(
    `DUPLICATE_LEDGER_ROW — one closure claimed by several rows (inflates OUR number by ${duplicates.length ? duplicates.length - new Set(duplicates.map((d) => d.Closure)).size : 0})`,
  );
  table(duplicates);
  console.log("");

  // ---- NOT_IN_LEDGER: FieldEZ counted it, no closed row claimed it.
  const claimed = new Set(claims.keys());
  const notInLedger = fieldezClosed
    .filter((c) => !claimed.has(c.key))
    .map((c) => ({
      "WO ID": c.woId || "-",
      "Case ID": c.caseId || "-",
      Region: c.aspCode || "(none)",
      Closed: c.closedOn,
      Status: c.status,
    }));
  console.log(
    `NOT_IN_LEDGER — FieldEZ counted it, no closed row in this report (${notInLedger.length})`,
  );
  table(notInLedger);
  console.log("");

  // ---- NO_CLOSURE_RECORD: closed row the vendor never reported a closure for.
  const orphans = noClosureRecord.map((row) => ({
    "Row Ticket": row.ticketId || "-",
    "Row Case": row.caseId || "-",
    Region: row.aspCode || "-",
  }));
  console.log(
    `NO_CLOSURE_RECORD — closed row with no stored closure, so no Flex Status (${orphans.length})`,
  );
  table(orphans);
  console.log("");

  console.log("HOW TO READ THIS");
  console.log(
    "  our ledger higher  -> look at DUPLICATE_LEDGER_ROW first; each extra row is +1",
  );
  console.log("  FieldEZ higher     -> look at NOT_IN_LEDGER");
  console.log(
    "  neither explains it -> the report loaded on screen is not this one; pass its report id",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabasePool());
