/**
 * End-to-end test for the same-day closed-calls behaviour, against the REAL local
 * Postgres and the REAL report generator (no mocks).
 *
 * Rule under test: a ticket absent from the Flex WIP upload is CLOSED, but only the
 * day's FIRST upload removes closed rows from the Records page. A ticket that
 * vanishes on a same-day re-upload is closed (ledger/KPIs) yet stays listed on the
 * Records page until the next day's first upload.
 *
 * Timeline (ticket sets per upload):
 *   Day 0  u1: A B C D   -> baseline, nothing closed
 *   Day 1  u1: A B C     -> D closed, off Records (day's first upload)
 *   Day 1  u2: A B       -> C closed mid-day, STAYS on Records; D stays off
 *   Day 1  u3: A B       -> unchanged: C still on Records, D still off
 *   Day 2  u1: A B       -> day boundary: C drops off Records
 *   Day 2  u2: A B D     -> D reappears in Flex -> active again
 *
 * All data is created under a dedicated throwaway region so carry-forward never
 * touches real report chains, and everything is deleted afterwards (also on start,
 * in case a previous run crashed).
 *
 * Run: npx tsx src/scripts/e2eSameDayClosedCalls.ts
 */
import type { PoolClient } from "pg";
import { closeDatabasePool, withTransaction } from "../config/database.js";
import { createUploadBatch } from "../repositories/uploadBatchRepository.js";
import { insertFlexWipRecords } from "../repositories/sourceRecordRepository.js";
import { normalizeTicketId } from "../services/normalization/valueNormalizer.js";
import { generateDailyCallPlanReport } from "../services/callPlanGenerator/dailyCallPlanGenerator.js";
import type { FlexWipParsedRecord } from "../types/sourceRecords.js";
import type { GeneratedDailyCallPlanReport } from "../types/reportGeneration.js";

const TEST_REGION_CODE = "E2ESDC01";
const TICKET = (suffix: string) => `E2E-SDC-${suffix}`;

const DAY0 = "2026-07-10";
const DAY1 = "2026-07-11";
const DAY2 = "2026-07-12";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` (expected ${String(expected)}, got ${String(actual)})`}`);
}

function flexRecord(suffix: string, rowNumber: number): FlexWipParsedRecord {
  const ticketId = TICKET(suffix);
  return {
    ticketId,
    normalizedTicketId: normalizeTicketId(ticketId),
    caseId: null,
    normalizedCaseId: null,
    createTime: new Date("2026-07-01T04:30:00.000Z"),
    product: "E2E Notebook",
    flexStatus: "Open",
    woOtcCode: "W-01",
    accountName: "E2E Account",
    customerName: `E2E Customer ${suffix}`,
    contact: null,
    customerEmail: null,
    partDescription: null,
    customerPincode: null,
    productLineName: "E2E Line",
    workLocation: TEST_REGION_CODE,
    productSerialNo: `SN-${suffix}`,
    businessSegment: "Computing",
    rawRow: {
      "Ticket ID": ticketId,
      "Business Segment": "Computing",
      "Product Serial No": `SN-${suffix}`,
    },
    rowNumber,
  };
}

async function cleanup(client: PoolClient): Promise<void> {
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

async function seedUpload(
  regionId: string,
  uploadedBy: string,
  fileName: string,
  ticketSuffixes: readonly string[],
): Promise<string> {
  return withTransaction(async (client) => {
    const batch = await createUploadBatch(
      {
        sourceType: "FLEX_WIP",
        originalFileName: fileName,
        storedFilePath: `e2e/${fileName}`,
        uploadedBy,
        regionId,
        rowCount: ticketSuffixes.length,
        errors: [],
      },
      client,
    );
    await insertFlexWipRecords(
      client,
      batch.id,
      ticketSuffixes.map((suffix, index) => flexRecord(suffix, index + 2)),
    );
    return batch.id;
  });
}

interface RowState {
  closed: boolean;
  sameDay: boolean;
  /** What the Records page shows: open rows plus same-day closed rows. */
  onRecordsPage: boolean;
}

function rowState(report: GeneratedDailyCallPlanReport, suffix: string): RowState | null {
  const row = report.rows.find((r) => r.enriched.ticket_id === TICKET(suffix));
  if (!row) return null;
  const closed = row.carryForward.closedSyntheticRow;
  const sameDay = row.carryForward.sameDayClosedRow;
  return { closed, sameDay, onRecordsPage: !closed || sameDay };
}

async function persistedState(
  reportId: string,
): Promise<Map<string, { changeType: string | null; sameDayClosed: boolean }>> {
  return withTransaction(async (client) => {
    const result = await client.query<{
      ticket_id: string;
      change_type: string | null;
      same_day_closed: boolean;
    }>(
      `SELECT ticket_id, change_type::TEXT AS change_type, same_day_closed
         FROM daily_call_plan_report_rows WHERE report_id = $1`,
      [reportId],
    );
    return new Map(
      result.rows.map((r) => [
        r.ticket_id,
        { changeType: r.change_type, sameDayClosed: r.same_day_closed },
      ]),
    );
  });
}

async function run(): Promise<void> {
  const { regionId, userId } = await withTransaction(async (client) => {
    await cleanup(client);
    const regionResult = await client.query<{ id: string }>(
      `INSERT INTO regions (code, name, is_active)
       VALUES ($1, 'E2E Same-Day Closed', TRUE)
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

  const generate = async (reportDate: string, tickets: readonly string[], fileName: string) => {
    const batchId = await seedUpload(regionId, userId, fileName, tickets);
    return generateDailyCallPlanReport({
      reportDate,
      generatedBy: userId,
      regionId,
      flexUploadBatchId: batchId,
      allowCreate: true,
    });
  };

  try {
    console.log("\nDay 0, upload 1 (A B C D) — baseline");
    const d0u1 = await generate(DAY0, ["A", "B", "C", "D"], "d0u1.xlsx");
    check("4 rows generated", d0u1.rows.length, 4);
    for (const s of ["A", "B", "C", "D"]) {
      check(`${s} is open`, rowState(d0u1, s)?.closed, false);
    }

    console.log("\nDay 1, upload 1 (A B C) — day's FIRST upload: D closes, off Records");
    const d1u1 = await generate(DAY1, ["A", "B", "C"], "d1u1.xlsx");
    check("D closed", rowState(d1u1, "D")?.closed, true);
    check("D NOT same-day (first upload of the day)", rowState(d1u1, "D")?.sameDay, false);
    check("D off the Records page", rowState(d1u1, "D")?.onRecordsPage, false);
    check("C still open", rowState(d1u1, "C")?.closed, false);

    console.log("\nDay 1, upload 2 (A B) — same-day re-upload: C closes but STAYS on Records");
    const d1u2 = await generate(DAY1, ["A", "B"], "d1u2.xlsx");
    check("C closed", rowState(d1u2, "C")?.closed, true);
    check("C same-day closed", rowState(d1u2, "C")?.sameDay, true);
    check("C still ON the Records page", rowState(d1u2, "C")?.onRecordsPage, true);
    check("D stays closed", rowState(d1u2, "D")?.closed, true);
    check("D stays OFF the Records page", rowState(d1u2, "D")?.onRecordsPage, false);
    const d1u2Db = await persistedState(d1u2.reportId);
    check("C persisted change_type CLOSED", d1u2Db.get(TICKET("C"))?.changeType, "CLOSED");
    check("C persisted same_day_closed TRUE", d1u2Db.get(TICKET("C"))?.sameDayClosed, true);
    check("D persisted same_day_closed FALSE", d1u2Db.get(TICKET("D"))?.sameDayClosed, false);

    console.log("\nDay 1, upload 3 (A B) — another same-day re-upload: nothing changes");
    const d1u3 = await generate(DAY1, ["A", "B"], "d1u3.xlsx");
    check("C still same-day closed (inherited)", rowState(d1u3, "C")?.sameDay, true);
    check("C still ON the Records page", rowState(d1u3, "C")?.onRecordsPage, true);
    check("D still OFF the Records page", rowState(d1u3, "D")?.onRecordsPage, false);

    console.log("\nDay 2, upload 1 (A B) — day boundary: C finally drops off Records");
    const d2u1 = await generate(DAY2, ["A", "B"], "d2u1.xlsx");
    check("C still closed", rowState(d2u1, "C")?.closed, true);
    check("C no longer same-day", rowState(d2u1, "C")?.sameDay, false);
    check("C off the Records page", rowState(d2u1, "C")?.onRecordsPage, false);
    check("A still open", rowState(d2u1, "A")?.closed, false);

    console.log("\nDay 2, upload 2 (A B D) — D reappears in Flex: active again");
    const d2u2 = await generate(DAY2, ["A", "B", "D"], "d2u2.xlsx");
    check("D reopened (not closed)", rowState(d2u2, "D")?.closed, false);
    check("D back on the Records page", rowState(d2u2, "D")?.onRecordsPage, true);
    check("C still closed and off Records", rowState(d2u2, "C")?.onRecordsPage, false);

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    await withTransaction(cleanup);
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
