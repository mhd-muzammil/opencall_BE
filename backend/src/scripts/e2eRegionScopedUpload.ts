/**
 * End-to-end test for region-scoped uploads, against the REAL local Postgres and
 * the REAL report generator (no mocks).
 *
 * Rule under test: a generation carrying allowedRegionAspCodes (a region admin's
 * upload) may only affect its own regions. Out-of-scope file rows are ignored (no
 * new cases added, stale data discarded); out-of-scope previous rows are carried
 * forward verbatim — active stays active (never closed by someone else's upload),
 * closed stays closed under the same-day rules. In-scope rows behave exactly like
 * a normal upload, including same-day closed semantics.
 *
 * Tickets live in two ASP codes: R1 (in scope for the masked uploads) and R2.
 *   Day 0  unmasked:  A(R1) B(R1) C(R2) D(R2)      -> baseline, 4 active
 *   Day 1  mask=[R1]: file A(R1) E(R1new) F(R2new) C(R2)
 *          -> A active; E added; F DROPPED (new out-of-scope);
 *             B closed (in-scope absent, day-first, off Records);
 *             C retained active (file's R2 data ignored); D retained active
 *   Day 1  mask=[R1]: file A -> E closed same-day (stays on Records);
 *             B/C/D unchanged
 *   Day 2  unmasked:  file A C D -> day boundary: E drops off Records;
 *             C and D active again from the real file
 *
 * All reports are tagged with a throwaway region (session isolation from the real
 * carry-forward chains) and everything is deleted afterwards.
 *
 * Run: npx tsx src/scripts/e2eRegionScopedUpload.ts
 */
import type { PoolClient } from "pg";
import { closeDatabasePool, withTransaction } from "../config/database.js";
import { createUploadBatch } from "../repositories/uploadBatchRepository.js";
import { insertFlexWipRecords } from "../repositories/sourceRecordRepository.js";
import { normalizeTicketId } from "../services/normalization/valueNormalizer.js";
import { generateDailyCallPlanReport } from "../services/callPlanGenerator/dailyCallPlanGenerator.js";
import type { FlexWipParsedRecord } from "../types/sourceRecords.js";
import type { GeneratedDailyCallPlanReport } from "../types/reportGeneration.js";

const TEST_REGION_CODE = "E2ERSU00";
const R1 = "E2ERSU01";
const R2 = "E2ERSU02";
const TICKET = (suffix: string) => `E2E-RSU-${suffix}`;

const DAY0 = "2026-07-10";
const DAY1 = "2026-07-11";
const DAY2 = "2026-07-12";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` (expected ${String(expected)}, got ${String(actual)})`}`);
}

function flexRecord(
  suffix: string,
  workLocation: string,
  rowNumber: number,
): FlexWipParsedRecord {
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
    workLocation,
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

interface RowState {
  closed: boolean;
  sameDay: boolean;
  retained: boolean;
  onRecordsPage: boolean;
}

function rowState(report: GeneratedDailyCallPlanReport, suffix: string): RowState | null {
  const row = report.rows.find((r) => r.enriched.ticket_id === TICKET(suffix));
  if (!row) return null;
  const closed = row.carryForward.closedSyntheticRow;
  return {
    closed,
    sameDay: row.carryForward.sameDayClosedRow,
    retained: row.carryForward.regionScopeRetainedRow,
    onRecordsPage: !closed || row.carryForward.sameDayClosedRow,
  };
}

async function run(): Promise<void> {
  const { regionId, userId } = await withTransaction(async (client) => {
    await cleanup(client);
    const regionResult = await client.query<{ id: string }>(
      `INSERT INTO regions (code, name, is_active)
       VALUES ($1, 'E2E Region Scoped Upload', TRUE)
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
    records: ReadonlyArray<readonly [suffix: string, workLocation: string]>,
    fileName: string,
    allowedRegionAspCodes: readonly string[] | null,
  ) => {
    const batchId = await withTransaction(async (client) => {
      const batch = await createUploadBatch(
        {
          sourceType: "FLEX_WIP",
          originalFileName: fileName,
          storedFilePath: `e2e/${fileName}`,
          uploadedBy: userId,
          regionId,
          rowCount: records.length,
          errors: [],
        },
        client,
      );
      await insertFlexWipRecords(
        client,
        batch.id,
        records.map(([suffix, workLocation], index) =>
          flexRecord(suffix, workLocation, index + 2),
        ),
      );
      return batch.id;
    });
    return generateDailyCallPlanReport({
      reportDate,
      generatedBy: userId,
      regionId,
      flexUploadBatchId: batchId,
      allowCreate: true,
      allowedRegionAspCodes,
    });
  };

  try {
    console.log("\nDay 0, unmasked (A,B in R1; C,D in R2) — baseline");
    const d0 = await generate(
      DAY0,
      [["A", R1], ["B", R1], ["C", R2], ["D", R2]],
      "rsu-d0.xlsx",
      null,
    );
    check("4 rows generated", d0.rows.length, 4);
    for (const s of ["A", "B", "C", "D"]) {
      check(`${s} is open`, rowState(d0, s)?.closed, false);
    }

    console.log("\nDay 1, masked to R1 (file: A, E new-R1, F new-R2, C) — first upload of the day");
    const d1u1 = await generate(
      DAY1,
      [["A", R1], ["E", R1], ["F", R2], ["C", R2]],
      "rsu-d1u1.xlsx",
      [R1],
    );
    check("A still open", rowState(d1u1, "A")?.closed, false);
    check("E (new, in scope) added", rowState(d1u1, "E")?.closed, false);
    check("F (new, out of scope) NOT added", rowState(d1u1, "F"), null);
    check("B (in scope, absent) closed", rowState(d1u1, "B")?.closed, true);
    check("B off the Records page (day-first)", rowState(d1u1, "B")?.onRecordsPage, false);
    check("C (out of scope, in file) retained active", rowState(d1u1, "C")?.retained, true);
    check("C not closed", rowState(d1u1, "C")?.closed, false);
    check("D (out of scope, absent) retained active", rowState(d1u1, "D")?.retained, true);
    check("D not closed", rowState(d1u1, "D")?.closed, false);
    check("row count (A,E active; C,D retained; B closed)", d1u1.rows.length, 5);

    console.log("\nDay 1, masked to R1 (file: A) — same-day re-upload: E closes but stays");
    const d1u2 = await generate(DAY1, [["A", R1]], "rsu-d1u2.xlsx", [R1]);
    check("E closed", rowState(d1u2, "E")?.closed, true);
    check("E same-day closed (stays on Records)", rowState(d1u2, "E")?.sameDay, true);
    check("E still ON the Records page", rowState(d1u2, "E")?.onRecordsPage, true);
    check("B stays closed, off Records", rowState(d1u2, "B")?.onRecordsPage, false);
    check("C still retained active", rowState(d1u2, "C")?.retained, true);
    check("D still retained active", rowState(d1u2, "D")?.retained, true);

    console.log("\nDay 2, unmasked (file: A, C, D) — day boundary + real data for R2");
    const d2 = await generate(
      DAY2,
      [["A", R1], ["C", R2], ["D", R2]],
      "rsu-d2.xlsx",
      null,
    );
    check("E closed, no longer same-day", rowState(d2, "E")?.sameDay, false);
    check("E off the Records page", rowState(d2, "E")?.onRecordsPage, false);
    check("B still closed", rowState(d2, "B")?.closed, true);
    check("C active from the file (not retained)", rowState(d2, "C")?.retained, false);
    check("C open", rowState(d2, "C")?.closed, false);
    check("D active from the file (not retained)", rowState(d2, "D")?.retained, false);

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
