/**
 * End-to-end test for WIP aging, against the REAL local Postgres, the REAL
 * report generator and the REAL Excel parser (no mocks).
 *
 * Reproduces the 2026-07-21 prod incident, where the whole WIP aging column
 * went blank, and proves both fixes:
 *
 *  Part 1 — Excel serial dates (parser level, real .xlsx file):
 *    The FieldEZ export shipped "Create Time" as UNFORMATTED cells, so every
 *    value arrived as a bare serial float (46191.5594…) and parsed to null.
 *    A real workbook is written with one serial-number cell, one dd-mm-yyyy
 *    text cell and one blank; parseFlexWipReport must decode the first two.
 *
 *  Part 2 — carry-forward inheritance (generator level, real DB):
 *    case_created_time was missing from the carry-forward manualValues map, so
 *    a ticket whose upload lost its Create Time also lost its aging even
 *    though yesterday's report held the date. Day 1 uploads tickets WITH
 *    create times; Day 2 re-uploads them WITHOUT (the broken export). The
 *    Day 2 report must inherit each ticket's date and compute a real aging.
 *
 * All data lives under a throwaway region and is deleted afterwards (also on
 * start, in case a previous run crashed).
 *
 * Run: npx tsx src/scripts/e2eWipAging.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolClient } from "pg";
import xlsx from "xlsx";
import { closeDatabasePool, withTransaction } from "../config/database.js";
import { createUploadBatch } from "../repositories/uploadBatchRepository.js";
import { insertFlexWipRecords } from "../repositories/sourceRecordRepository.js";
import { normalizeTicketId } from "../services/normalization/valueNormalizer.js";
import { generateDailyCallPlanReport } from "../services/callPlanGenerator/dailyCallPlanGenerator.js";
import { parseFlexWipReport } from "../services/excelParser/sourceParsers.js";
import type { FlexWipParsedRecord } from "../types/sourceRecords.js";
import type { GeneratedDailyCallPlanReport } from "../types/reportGeneration.js";

const TEST_REGION_CODE = "E2EWIP01";
const TICKET = (suffix: string) => `E2E-WIP-${suffix}`;

const DAY1 = "2026-07-20";
const DAY2 = "2026-07-21";

// Real dates for the two carried tickets (mirrors WO-034696026 / WO-034718705
// from the incident, whose dates were sitting in the previous day's report).
const CREATED_A = new Date("2026-06-06T10:08:12.000Z");
const CREATED_B = new Date("2026-06-09T06:07:04.000Z");

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : ` (${detail})`}`);
}

// ---------------------------------------------------------------------------
// Part 1 — real workbook with an unformatted (serial) Create Time cell
// ---------------------------------------------------------------------------

function runSerialDateParserCase(): void {
  console.log("\nPart 1 — Excel serial-date Create Time through the real parser");

  const header = [
    "Ticket ID", "Case Id", "Create Time", "Status", "Product", "WO OTC Code",
    "Account Name", "Customer Name", "Contact", "Customer Email",
    "Part Description", "Customer Pincode", "Product Line Name",
    "Work Location", "Business Segment",
  ];
  const baseRow = (ticket: string, createTime: number | string) => [
    ticket, "5160000001", createTime, "Open", "E2E Notebook", "W-01",
    "E2E Account", "E2E Customer", "9999999999", "e2e@example.com",
    "SPS-PART", "600001", "E2E Line", TEST_REGION_CODE, "Computing",
  ];

  // 46191.559415868054 is a real value from the broken 2026-07-21 prod upload
  // = 2026-06-18 13:25:34 IST = 2026-06-18T07:55:34Z.
  const rows = [
    header,
    baseRow(TICKET("S1"), 46191.559415868054),
    baseRow(TICKET("S2"), "28-04-2026 01:34:30 PM"),
    baseRow(TICKET("S3"), ""),
  ];

  const dir = mkdtempSync(join(tmpdir(), "e2e-wip-"));
  const filePath = join(dir, "flex-serial.xlsx");
  try {
    const sheet = xlsx.utils.aoa_to_sheet(rows);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, sheet, "FLEX WIP");
    xlsx.writeFile(workbook, filePath);

    const parsed = parseFlexWipReport(filePath);
    const bySuffix = new Map(
      parsed.records.map((record) => [record.ticketId, record]),
    );

    const s1 = bySuffix.get(TICKET("S1"));
    const s2 = bySuffix.get(TICKET("S2"));
    const s3 = bySuffix.get(TICKET("S3"));

    check("3 rows parsed", parsed.records.length === 3, `got ${parsed.records.length}`);
    check(
      "serial 46191.5594… decodes to 2026-06-18T07:55:34Z",
      s1?.createTime?.toISOString() === "2026-06-18T07:55:34.000Z",
      `got ${String(s1?.createTime?.toISOString())}`,
    );
    check(
      "dd-mm-yyyy text still parses (no regression)",
      s2?.createTime?.toISOString() === "2026-04-28T08:04:30.000Z",
      `got ${String(s2?.createTime?.toISOString())}`,
    );
    check("blank Create Time stays null", s3?.createTime === null, `got ${String(s3?.createTime)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Part 2 — carry-forward inherits case_created_time (real DB + generator)
// ---------------------------------------------------------------------------

function flexRecord(
  suffix: string,
  rowNumber: number,
  createTime: Date | null,
): FlexWipParsedRecord {
  const ticketId = TICKET(suffix);
  return {
    ticketId,
    normalizedTicketId: normalizeTicketId(ticketId),
    caseId: null,
    normalizedCaseId: null,
    createTime,
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
  rows: ReadonlyArray<readonly [string, Date | null]>,
): Promise<string> {
  return withTransaction(async (client) => {
    const batch = await createUploadBatch(
      {
        sourceType: "FLEX_WIP",
        originalFileName: fileName,
        storedFilePath: `e2e/${fileName}`,
        uploadedBy,
        regionId,
        rowCount: rows.length,
        errors: [],
      },
      client,
    );
    await insertFlexWipRecords(
      client,
      batch.id,
      rows.map(([suffix, createTime], index) =>
        flexRecord(suffix, index + 2, createTime),
      ),
    );
    return batch.id;
  });
}

function agingOf(report: GeneratedDailyCallPlanReport, suffix: string): string {
  const row = report.rows.find((r) => r.enriched.ticket_id === TICKET(suffix));
  return String(row?.output["WIP aging"] ?? "");
}

function createdOf(report: GeneratedDailyCallPlanReport, suffix: string): string | null {
  const row = report.rows.find((r) => r.enriched.ticket_id === TICKET(suffix));
  return row?.enriched.case_created_time ?? null;
}

async function runCarryForwardCase(): Promise<void> {
  console.log("\nPart 2 — Day 2 upload loses Create Time; aging must survive via carry-forward");

  const { regionId, userId } = await withTransaction(async (client) => {
    await cleanup(client);
    const regionResult = await client.query<{ id: string }>(
      `INSERT INTO regions (code, name, is_active)
       VALUES ($1, 'E2E WIP Aging', TRUE)
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

  try {
    console.log("\n  Day 1 — healthy upload, A and B carry real Create Times");
    const day1Batch = await seedUpload(regionId, userId, "wip-d1.xlsx", [
      ["A", CREATED_A],
      ["B", CREATED_B],
    ]);
    const day1 = await generateDailyCallPlanReport({
      reportDate: DAY1,
      generatedBy: userId,
      regionId,
      flexUploadBatchId: day1Batch,
      allowCreate: true,
    });

    check("A aging computed on Day 1", /^\d+$/.test(agingOf(day1, "A")) && Number(agingOf(day1, "A")) > 0, `got "${agingOf(day1, "A")}"`);
    check("B aging computed on Day 1", /^\d+$/.test(agingOf(day1, "B")) && Number(agingOf(day1, "B")) > 0, `got "${agingOf(day1, "B")}"`);

    console.log("\n  Day 2 — broken upload: A, B and NEW ticket C all arrive with NO Create Time");
    const day2Batch = await seedUpload(regionId, userId, "wip-d2.xlsx", [
      ["A", null],
      ["B", null],
      ["C", null],
    ]);
    const day2 = await generateDailyCallPlanReport({
      reportDate: DAY2,
      generatedBy: userId,
      regionId,
      flexUploadBatchId: day2Batch,
      allowCreate: true,
    });

    // The regression under test: pre-fix, manualValues lacked case_created_time,
    // the inherited date was invisible to carry-forward, and these went blank.
    check(
      "A inherited its Day-1 case_created_time",
      createdOf(day2, "A") !== null &&
        new Date(createdOf(day2, "A") as string).getTime() === CREATED_A.getTime(),
      `got ${String(createdOf(day2, "A"))}`,
    );
    check(
      "B inherited its Day-1 case_created_time",
      createdOf(day2, "B") !== null &&
        new Date(createdOf(day2, "B") as string).getTime() === CREATED_B.getTime(),
      `got ${String(createdOf(day2, "B"))}`,
    );
    check("A aging still populated on Day 2", /^\d+$/.test(agingOf(day2, "A")) && Number(agingOf(day2, "A")) > 0, `got "${agingOf(day2, "A")}"`);
    check("B aging still populated on Day 2", /^\d+$/.test(agingOf(day2, "B")) && Number(agingOf(day2, "B")) > 0, `got "${agingOf(day2, "B")}"`);
    // A genuinely new call with no date anywhere has nothing to inherit: its
    // aging stays blank until a dated upload or a manual edit supplies one.
    check("C (new, dateless) has no aging — documented gap, not a bug", agingOf(day2, "C") === "", `got "${agingOf(day2, "C")}"`);

    // And the inherited date must be PERSISTED, so the next day inherits again.
    const persisted = await withTransaction(async (client) => {
      const result = await client.query<{ ticket_id: string; case_created_time: string | null; wip_aging: string | null }>(
        `SELECT ticket_id, case_created_time::TEXT AS case_created_time, wip_aging
           FROM daily_call_plan_report_rows WHERE report_id = $1`,
        [day2.reportId],
      );
      return new Map(result.rows.map((r) => [r.ticket_id, r]));
    });
    check(
      "A persisted with case_created_time on Day 2",
      Boolean(persisted.get(TICKET("A"))?.case_created_time),
      `got ${String(persisted.get(TICKET("A"))?.case_created_time)}`,
    );
    check(
      "A persisted with wip_aging on Day 2",
      Boolean(persisted.get(TICKET("A"))?.wip_aging),
      `got ${String(persisted.get(TICKET("A"))?.wip_aging)}`,
    );
  } finally {
    await withTransaction(cleanup);
  }
}

async function run(): Promise<void> {
  runSerialDateParserCase();
  await runCarryForwardCase();

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exitCode = 1;
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabasePool();
  });
