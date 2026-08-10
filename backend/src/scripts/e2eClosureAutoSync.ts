/**
 * End-to-end test for the closure auto-sync feature, against the REAL local Postgres,
 * the REAL report generator and REAL .xlsx files (no mocks).
 *
 * What it proves:
 *   1. The merge import touches ONLY the work orders in its file. A 48-WO history import
 *      followed by a 13-WO today-only merge leaves 61 rows, not 13. This is the
 *      regression test for routing the hourly sync through the DELETE-everything path.
 *   2. The Flex Status overlay lands on the matched rows, the vendor's WIP value survives
 *      in `Flex Status (WIP)`, and unmatched rows are untouched.
 *   3. `flex_status_unchanged_days` and `previous_flex_status` still compute off the
 *      STORED vendor value — a closure must not reset a stale-status streak.
 *   4. Nothing is written to `daily_call_plan_report_rows.flex_status`.
 *   5. The three reconciliation buckets come out right.
 *
 * All data is created under a dedicated throwaway region and cleaned up afterwards
 * (also on start, in case a previous run crashed). The closure table is global, so only
 * this run's own key prefixes are removed from it — real imported data is left alone.
 *
 * Requires migration 041. Run: npx tsx src/scripts/e2eClosureAutoSync.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PoolClient } from "pg";
import xlsx from "xlsx";
import { closeDatabasePool, query, withTransaction } from "../config/database.js";
import { createUploadBatch } from "../repositories/uploadBatchRepository.js";
import { insertFlexWipRecords } from "../repositories/sourceRecordRepository.js";
import { normalizeTicketId } from "../services/normalization/valueNormalizer.js";
import { generateDailyCallPlanReport } from "../services/callPlanGenerator/dailyCallPlanGenerator.js";
import { enrichReportWithClosureDates } from "../services/closureDates/closureDateEnricher.js";
import { importClosureDatesFromFile } from "../services/closureDates/closureDateImportService.js";
import { reconcileClosuresForDate } from "../services/closureDates/closureReconciliationService.js";
import type { FlexWipParsedRecord } from "../types/sourceRecords.js";
import type { GeneratedDailyCallPlanReport } from "../types/reportGeneration.js";

const TEST_REGION_CODE = "E2ECAS01";
const HISTORY_PREFIX = "E2E-CAS-HIST-";
const TICKET = (suffix: string) => `E2E-CAS-${suffix}`;

const DAY0 = "2026-06-10";
const DAY1 = "2026-06-11";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}` +
      (ok ? "" : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
}

// ------------------------------------------------------------------ fixtures

function flexRecord(
  suffix: string,
  rowNumber: number,
  flexStatus: string,
): FlexWipParsedRecord {
  const ticketId = TICKET(suffix);
  return {
    ticketId,
    normalizedTicketId: normalizeTicketId(ticketId),
    caseId: `CASE-${suffix}`,
    normalizedCaseId: `CASE-${suffix}`,
    createTime: new Date("2026-06-01T04:30:00.000Z"),
    product: "E2E Notebook",
    flexStatus,
    woOtcCode: "W-01",
    accountName: "E2E Account",
    customerName: `E2E Customer ${suffix}`,
    contact: null,
    customerEmail: null,
    partDescription: null,
    customerPincode: null,
    customerAddress: null,
    commonAddress: null,
    customerCity: null,
    customerState: null,
    productLineName: "E2E Line",
    workLocation: TEST_REGION_CODE,
    productSerialNo: `SN-${suffix}`,
    businessSegment: "Computing",
    rawRow: { "Ticket ID": ticketId },
    rowNumber,
  };
}

interface ClosureFixtureRow {
  ticketNo: string;
  caseId: string;
  status: string;
  /** Excel serial, or "" for a cancellation Flex closed without a closure date. */
  closureDate: number | "";
  failureCode?: string;
  workLocation?: string;
  activityTime?: number;
}

/** Excel serial for an IST wall-clock timestamp. */
function serial(y: number, m: number, d: number, H = 0, M = 0): number {
  return Date.UTC(y, m - 1, d) / 86_400_000 + 25_569 + (H * 3600 + M * 60) / 86_400;
}

/** Writes a real Flex Closure ASP Report workbook so the whole parse path is exercised. */
function writeClosureWorkbook(dir: string, name: string, rows: ClosureFixtureRow[]): string {
  const sheet = xlsx.utils.json_to_sheet(
    rows.map((row) => ({
      "Ticket No": row.ticketNo,
      "Case Id": row.caseId,
      Status: row.status,
      "Status Remarks": `remark for ${row.ticketNo}`,
      "Closure Date": row.closureDate,
      "Failure Code": row.failureCode ?? "",
      "Resolution comments": "",
      "Work Location": row.workLocation ?? TEST_REGION_CODE,
      "ASP Name": "E2E ASP",
      "Activity Time": row.activityTime ?? serial(2026, 6, 11, 9, 30),
    })),
  );
  const book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(book, sheet, "Report");
  const file = path.join(dir, name);
  xlsx.writeFile(book, file);
  return file;
}

// ------------------------------------------------------------------- cleanup

async function cleanup(client: PoolClient): Promise<void> {
  await client.query(
    `DELETE FROM case_closure_dates
      WHERE wo_id LIKE $1 OR wo_id LIKE $2 OR case_id LIKE $3`,
    [`${HISTORY_PREFIX}%`, "E2E-CAS-%", "CASE-E2E%"],
  );
  await client.query(
    `DELETE FROM report_row_diffs
      WHERE current_session_id IN (
        SELECT sessions.id FROM report_history_sessions sessions
        JOIN regions ON regions.id = sessions.region_id
        WHERE regions.code = $1)`,
    [TEST_REGION_CODE],
  );
  await client.query(
    `DELETE FROM report_comparisons
      WHERE current_session_id IN (
        SELECT sessions.id FROM report_history_sessions sessions
        JOIN regions ON regions.id = sessions.region_id
        WHERE regions.code = $1)
        OR previous_session_id IN (
        SELECT sessions.id FROM report_history_sessions sessions
        JOIN regions ON regions.id = sessions.region_id
        WHERE regions.code = $1)`,
    [TEST_REGION_CODE],
  );
  await client.query(
    `DELETE FROM daily_call_plan_report_rows
      WHERE report_id IN (
        SELECT reports.id FROM daily_call_plan_reports reports
        JOIN regions ON regions.id = reports.region_id
        WHERE regions.code = $1)`,
    [TEST_REGION_CODE],
  );
  await client.query(
    `DELETE FROM report_history_sessions
      WHERE region_id IN (SELECT id FROM regions WHERE code = $1)`,
    [TEST_REGION_CODE],
  );
  await client.query(
    `DELETE FROM daily_call_plan_reports
      WHERE region_id IN (SELECT id FROM regions WHERE code = $1)`,
    [TEST_REGION_CODE],
  );
  await client.query(
    `DELETE FROM flex_wip_records
      WHERE upload_batch_id IN (
        SELECT batches.id FROM source_upload_batches batches
        JOIN regions ON regions.id = batches.region_id
        WHERE regions.code = $1)`,
    [TEST_REGION_CODE],
  );
  await client.query(
    `DELETE FROM source_upload_batches
      WHERE region_id IN (SELECT id FROM regions WHERE code = $1)`,
    [TEST_REGION_CODE],
  );
  await client.query(`DELETE FROM regions WHERE code = $1`, [TEST_REGION_CODE]);
}

// ----------------------------------------------------------------------- run

function outputOf(report: GeneratedDailyCallPlanReport, suffix: string) {
  const row = report.rows.find((r) => r.enriched.ticket_id === TICKET(suffix));
  return row ? (row.output as unknown as Record<string, unknown>) : null;
}

async function run(): Promise<void> {
  const tempDir = mkdtempSync(path.join(tmpdir(), "e2e-closure-"));

  const { regionId, userId } = await withTransaction(async (client) => {
    await cleanup(client);
    const regionResult = await client.query<{ id: string }>(
      `INSERT INTO regions (code, name, is_active)
       VALUES ($1, 'E2E Closure Auto-Sync', TRUE)
       ON CONFLICT (code) DO UPDATE SET is_active = TRUE
       RETURNING id`,
      [TEST_REGION_CODE],
    );
    const userResult = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'SUPER_ADMIN' AND is_active LIMIT 1`,
    );
    const regionRow = regionResult.rows[0];
    const userRow = userResult.rows[0];
    if (!regionRow || !userRow) {
      throw new Error("Setup failed: need a SUPER_ADMIN user and a test region");
    }
    return { regionId: regionRow.id, userId: userRow.id };
  });

  const generate = async (
    reportDate: string,
    tickets: ReadonlyArray<{ suffix: string; flexStatus: string }>,
    fileName: string,
  ) => {
    const batchId = await withTransaction(async (client) => {
      const batch = await createUploadBatch(
        {
          sourceType: "FLEX_WIP",
          originalFileName: fileName,
          storedFilePath: `e2e/${fileName}`,
          uploadedBy: userId,
          regionId,
          rowCount: tickets.length,
          errors: [],
        },
        client,
      );
      await insertFlexWipRecords(
        client,
        batch.id,
        tickets.map((t, index) => flexRecord(t.suffix, index + 2, t.flexStatus)),
      );
      return batch.id;
    });
    return generateDailyCallPlanReport({
      reportDate,
      generatedBy: userId,
      regionId,
      flexUploadBatchId: batchId,
      allowCreate: true,
    });
  };

  try {
    // ------------------------------------------------ 1. merge preserves history
    console.log("\n1. Merge import keeps history (the DELETE-everything regression)");

    const historyRows: ClosureFixtureRow[] = Array.from({ length: 48 }, (_, i) => ({
      ticketNo: `${HISTORY_PREFIX}${i}`,
      caseId: `CASE-${HISTORY_PREFIX}${i}`,
      status: "WO Closed",
      closureDate: serial(2026, 6, 1),
    }));
    const historyFile = writeClosureWorkbook(tempDir, "history.xlsx", historyRows);
    const historyResult = await importClosureDatesFromFile(historyFile, {
      mode: "replace",
      importSource: "MANUAL",
    });
    check("48 work orders imported by the manual replace", historyResult.imported, 48);

    const todayRows: ClosureFixtureRow[] = [
      // A: closed on both sides.
      { ticketNo: TICKET("A"), caseId: "CASE-A", status: "WO Closed", closureDate: serial(2026, 6, 11), failureCode: "FC-1" },
      // B: Flex closed it, but our evening status will NOT say closed.
      { ticketNo: TICKET("B"), caseId: "CASE-B", status: "Closed - Canceled", closureDate: "", activityTime: serial(2026, 6, 11, 0, 31) },
      // Ten more so the merge batch is 13 work orders, per the regression scenario.
      ...Array.from({ length: 11 }, (_, i) => ({
        ticketNo: TICKET(`X${i}`),
        caseId: `CASE-X${i}`,
        status: "WO Closed",
        closureDate: serial(2026, 6, 11),
      })),
    ];
    const todayFile = writeClosureWorkbook(tempDir, "today.xlsx", todayRows);
    const todayResult = await importClosureDatesFromFile(todayFile, {
      mode: "merge",
      importSource: "AUTO",
    });
    check("13 work orders merged", todayResult.imported, 13);
    check("one row stored with no closure date", todayResult.withoutClosureDate, 1);
    check("cancellation classified as cancelled, not closed", todayResult.byStatus.cancelled, 1);
    check("the other 12 are genuine closures", todayResult.byStatus.closed, 12);

    const totalAfterMerge = await query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM case_closure_dates
        WHERE wo_id LIKE $1 OR wo_id LIKE $2`,
      [`${HISTORY_PREFIX}%`, "E2E-CAS-%"],
    );
    check(
      "61 rows survive the merge (48 history + 13 today), not 13",
      Number(totalAfterMerge.rows[0]?.count ?? 0),
      61,
    );

    const cancelled = await query<{ closure_date: string | null; closed_on: string | null }>(
      `SELECT closure_date, to_char(closed_on, 'YYYY-MM-DD') AS closed_on
         FROM case_closure_dates WHERE wo_id = $1`,
      [TICKET("B")],
    );
    check("cancellation stored with a NULL closure_date", cancelled.rows[0]?.closure_date, null);
    check(
      "…and closed_on taken from its 00:31 IST Activity Time, not the day before",
      cancelled.rows[0]?.closed_on,
      "2026-06-11",
    );

    // ------------------------------------------------ 2. the Flex Status overlay
    console.log("\n2. Flex Status overlay at serve time");

    // Day 0 establishes the stale-status streak; day 1 keeps the same vendor status,
    // so flex_status_unchanged_days must grow regardless of the closure overlay.
    await generate(
      DAY0,
      [
        { suffix: "A", flexStatus: "In Progress" },
        { suffix: "B", flexStatus: "Request to Cancel" },
        { suffix: "C", flexStatus: "In Progress" },
      ],
      "day0.xlsx",
    );
    const day1 = await generate(
      DAY1,
      [
        { suffix: "A", flexStatus: "In Progress" },
        { suffix: "B", flexStatus: "Request to Cancel" },
        { suffix: "C", flexStatus: "In Progress" },
      ],
      "day1.xlsx",
    );

    const beforeA = outputOf(day1, "A");
    const unchangedDaysBefore =
      day1.rows.find((r) => r.enriched.ticket_id === TICKET("A"))?.comparison
        ?.flexStatusUnchangedDays ?? null;
    check("vendor status before the overlay", beforeA?.["Flex Status"], "In Progress");

    const enriched = await enrichReportWithClosureDates(day1);
    const afterA = outputOf(enriched, "A");
    const afterC = outputOf(enriched, "C");

    check("matched row now shows Flex's closure status", afterA?.["Flex Status"], "WO Closed");
    check("vendor value preserved in Flex Status (WIP)", afterA?.["Flex Status (WIP)"], "In Progress");
    check("closure remarks stamped", afterA?.["Status Remarks"], `remark for ${TICKET("A")}`);
    check("Case Closed Date stamped", afterA?.["Case Closed Date"], "11-06-2026");
    check("unmatched row untouched", afterC?.["Flex Status"], "In Progress");
    check("unmatched row gets no WIP column", afterC?.["Flex Status (WIP)"], undefined);

    const unchangedDaysAfter =
      enriched.rows.find((r) => r.enriched.ticket_id === TICKET("A"))?.comparison
        ?.flexStatusUnchangedDays ?? null;
    check(
      "flex_status_unchanged_days unchanged by the overlay",
      unchangedDaysAfter,
      unchangedDaysBefore,
    );

    const stored = await query<{ flex_status: string | null }>(
      `SELECT rows.flex_status
         FROM daily_call_plan_report_rows rows
         JOIN daily_call_plan_reports reports ON reports.id = rows.report_id
        WHERE reports.report_date = $1::date AND rows.ticket_id = $2`,
      [DAY1, TICKET("A")],
    );
    check(
      "daily_call_plan_report_rows.flex_status NEVER written",
      stored.rows[0]?.flex_status,
      "In Progress",
    );

    // ------------------------------------------------ 3. reconciliation buckets
    console.log("\n3. Reconciliation buckets");

    // A closed here AND in Flex; B closed in Flex only; C closed here only.
    await query(
      `UPDATE daily_call_plan_report_rows rows
          SET evening_rtpl_status = $3
         FROM daily_call_plan_reports reports
        WHERE reports.id = rows.report_id
          AND reports.report_date = $1::date
          AND rows.ticket_id = $2`,
      [DAY1, TICKET("A"), "Case-Closed"],
    );
    await query(
      `UPDATE daily_call_plan_report_rows rows
          SET evening_rtpl_status = $3
         FROM daily_call_plan_reports reports
        WHERE reports.id = rows.report_id
          AND reports.report_date = $1::date
          AND rows.ticket_id = $2`,
      [DAY1, TICKET("B"), "Part Order Pending"],
    );
    await query(
      `UPDATE daily_call_plan_report_rows rows
          SET evening_rtpl_status = $3
         FROM daily_call_plan_reports reports
        WHERE reports.id = rows.report_id
          AND reports.report_date = $1::date
          AND rows.ticket_id = $2`,
      [DAY1, TICKET("C"), "WO-closed"],
    );

    const recon = await reconcileClosuresForDate({
      date: DAY1,
      allowedAspCodes: [TEST_REGION_CODE],
    });

    check("A: closed on both sides", recon.counts.matched, 1);
    check("A is the matched one", recon.matched[0]?.ticketId, TICKET("A"));
    check("C: closed here, Flex has nothing", recon.counts.closedHereNotInFlex, 1);
    check("C is the one we closed alone", recon.closedHereNotInFlex[0]?.ticketId, TICKET("C"));
    // B plus the 11 filler work orders Flex closed that are not in the day's report.
    check("B + 11 fillers: closed in Flex, not here", recon.counts.closedInFlexNotHere, 12);
    check(
      "B's cancellation status rides along so it is distinguishable",
      recon.closedInFlexNotHere.find((r) => r.ticketId === TICKET("B"))?.closureStatus,
      "Closed - Canceled",
    );

    const scoped = await reconcileClosuresForDate({
      date: DAY1,
      allowedAspCodes: ["SOME-OTHER-ASP"],
    });
    check("an out-of-scope principal sees nothing", scoped.counts.matched, 0);
    check("…and no Flex-side rows either", scoped.counts.closedInFlexNotHere, 0);

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    await withTransaction(cleanup);
    rmSync(tempDir, { recursive: true, force: true });
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
