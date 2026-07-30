/**
 * End-to-end test for the same-day Evening (EOD) status wipe, against the REAL
 * local Postgres and the REAL report generator (no mocks).
 *
 * Production scenario under test (2026-07-29, "Evening status disappears against
 * Scheduled cases"): the FieldEZ auto-sync worker uploads a fresh flex-only batch
 * every ~15 minutes, each creating a NEW report. CRM users type Evening statuses
 * into whatever report their browser loaded — frequently no longer the newest one
 * (the workspace only auto-switches for sessions that themselves uploaded).
 * Carry-forward sources rows from ONE report (LIMIT 1), so an Evening entered on
 * any other same-day report used to vanish from every later report.
 *
 * The second vector (2026-07-30) is the tie-break that guards that recovery: it
 * compared rows.updated_at, a WHOLE-ROW timestamp stamped by every manual edit.
 * So editing an unrelated field (Engineer, Morning, Remarks) on a row whose
 * Evening was blank was byte-identical in the DB to "the user just cleared the
 * Evening", and the recovery refused to run. Migration 040 gives the Evening its
 * own edit timestamp; this script exercises both readings of a blank Evening.
 *
 * Timeline (worker-shaped: flex-only batches, unscoped, new batch per upload):
 *   Day 1 u1: rows A B         -> user schedules both, sets Evening on A
 *   Day 1 u2 (worker)          -> new report carries Morning + A's Evening
 *   user sets Evening on B ON THE OLD u1 REPORT (stale tab)
 *   Day 1 u3 (worker)          -> B's Evening must SURVIVE (the old wipe)
 *   regen of u2's report       -> its blank B Evening must be HEALED in the DB
 *   user edits only B's ENGINEER on the newest report
 *   Day 1 u4 (worker)          -> B's Evening must SURVIVE: an unrelated field
 *                                 edit is not a deliberate Evening clear
 *   user CLEARS A's Evening on the newest report
 *   Day 1 u5 (worker)          -> the clear must stand (no resurrection)
 *   Day 2 u1                   -> day boundary: Evening promotes to Morning,
 *                                 Evenings start blank
 *
 * Report dates are far in the past (2020) so no real report chain can ever be the
 * carry-forward source, and everything is deleted afterwards (also on start, in
 * case a previous run crashed).
 *
 * Run: npx tsx src/scripts/e2eEveningStatusWipe.ts
 */
import type { PoolClient } from "pg";
import { closeDatabasePool, query, withTransaction } from "../config/database.js";
import { createUploadBatch } from "../repositories/uploadBatchRepository.js";
import { insertFlexWipRecords } from "../repositories/sourceRecordRepository.js";
import { normalizeTicketId } from "../services/normalization/valueNormalizer.js";
import { generateDailyCallPlanReport } from "../services/callPlanGenerator/dailyCallPlanGenerator.js";
import type { FlexWipParsedRecord } from "../types/sourceRecords.js";
import type { GeneratedDailyCallPlanReport } from "../types/reportGeneration.js";

const TEST_REGION_CODE = "E2EEVW01";
const TICKET = (suffix: string) => `E2E-EVW-${suffix}`;

// Far in the past: previous_session picks the latest report on-or-before this
// date, and no real report exists this early, so the test chain is isolated.
const DAY1 = "2020-01-05";
const DAY2 = "2020-01-06";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` (expected ${String(expected)}, got ${String(actual)})`}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flexRecord(suffix: string, rowNumber: number): FlexWipParsedRecord {
  const ticketId = TICKET(suffix);
  return {
    ticketId,
    normalizedTicketId: normalizeTicketId(ticketId),
    caseId: null,
    normalizedCaseId: null,
    createTime: new Date("2020-01-02T04:30:00.000Z"),
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

const createdBatchIds: string[] = [];

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
  // Worker-shaped batches are UNSCOPED (region_id NULL), so they are tracked by
  // id — plus a name-pattern sweep for batches left by a crashed previous run.
  await client.query(
    `DELETE FROM flex_wip_records
      WHERE upload_batch_id IN (
        SELECT id FROM source_upload_batches
        WHERE id = ANY($1::uuid[]) OR original_file_name LIKE 'e2e-evw-%')`,
    [createdBatchIds],
  );
  await client.query(
    `DELETE FROM source_upload_batches
      WHERE id = ANY($1::uuid[]) OR original_file_name LIKE 'e2e-evw-%'`,
    [createdBatchIds],
  );
  await client.query(`DELETE FROM regions WHERE code = $1`, [TEST_REGION_CODE]);
}

async function seedUpload(
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
        // The FieldEZ worker uploads with no region scope.
        regionId: null,
        rowCount: ticketSuffixes.length,
        errors: [],
      },
      client,
    );
    createdBatchIds.push(batch.id);
    await insertFlexWipRecords(
      client,
      batch.id,
      ticketSuffixes.map((suffix, index) => flexRecord(suffix, index + 2)),
    );
    return batch.id;
  });
}

/** Simulates a user edit exactly as the PATCH route persists it (updated_at stamped). */
async function userEdit(
  reportId: string,
  suffix: string,
  fields: { rtplStatus?: string; engineer?: string; evening?: string | null },
): Promise<void> {
  const sets: string[] = ["updated_at = clock_timestamp()"];
  const params: unknown[] = [reportId, TICKET(suffix)];
  if (fields.rtplStatus !== undefined) {
    params.push(fields.rtplStatus);
    sets.push(`rtpl_status = $${params.length}`);
  }
  if (fields.engineer !== undefined) {
    params.push(fields.engineer);
    sets.push(`engineer = $${params.length}`);
  }
  if (fields.evening !== undefined) {
    params.push(fields.evening);
    sets.push(`evening_rtpl_status = $${params.length}`);
    // Only an edit that carries the Evening stamps the Evening's own time —
    // exactly what updateDailyCallPlanReportRowManualFields does. Editing
    // rtpl_status/engineer alone must leave it untouched, or this script
    // cannot reproduce the wipe it exists to catch.
    sets.push("evening_rtpl_status_updated_at = clock_timestamp()");
  }
  const result = await query(
    `UPDATE daily_call_plan_report_rows SET ${sets.join(", ")}
      WHERE report_id = $1 AND ticket_id = $2`,
    params,
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error(`userEdit matched ${String(result.rowCount)} rows for ${TICKET(suffix)}`);
  }
  // Keep user edits strictly ordered at millisecond resolution (the authority
  // compares timestamps after a pg-text -> JS Date round trip).
  await sleep(20);
}

function reportEvening(
  report: GeneratedDailyCallPlanReport,
  suffix: string,
): string | null {
  const row = report.rows.find((r) => r.enriched.ticket_id === TICKET(suffix));
  return row ? (row.enriched.evening_rtpl_status ?? null) : null;
}

function reportMorning(
  report: GeneratedDailyCallPlanReport,
  suffix: string,
): string | null {
  const row = report.rows.find((r) => r.enriched.ticket_id === TICKET(suffix));
  return row ? (row.enriched.rtpl_status ?? null) : null;
}

async function persistedEvening(
  reportId: string,
  suffix: string,
): Promise<string | null> {
  const result = await query<{ evening_rtpl_status: string | null }>(
    `SELECT evening_rtpl_status FROM daily_call_plan_report_rows
      WHERE report_id = $1 AND ticket_id = $2`,
    [reportId, TICKET(suffix)],
  );
  return result.rows[0]?.evening_rtpl_status ?? null;
}

async function run(): Promise<void> {
  const { regionId, userId } = await withTransaction(async (client) => {
    await cleanup(client);
    const regionResult = await client.query<{ id: string }>(
      `INSERT INTO regions (code, name, is_active)
       VALUES ($1, 'E2E Evening Wipe', TRUE)
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

  // Worker-shaped generation: flex-only (no Renderways/call plan -> Morning
  // arrives blank), unscoped batch, a brand-new batch (and report) per cycle.
  // regionId tags the report/session for cleanup only; the batch is unscoped.
  const workerCycle = async (reportDate: string, fileName: string) => {
    const batchId = await seedUpload(userId, fileName, ["A", "B"]);
    return generateDailyCallPlanReport({
      reportDate,
      generatedBy: userId,
      regionId,
      flexUploadBatchId: batchId,
      allowCreate: true,
    });
  };

  try {
    console.log("\nDay 1, upload 1 — first report of the day (fresh, blank Evening)");
    const r1 = await workerCycle(DAY1, "e2e-evw-u1.xlsx");
    check("A present", reportMorning(r1, "A") !== null, true);
    check("A Evening starts blank", reportEvening(r1, "A"), null);

    console.log("\nUser schedules A and B on report 1; sets Evening on A");
    await userEdit(r1.reportId, "A", { rtplStatus: "Scheduled", engineer: "E2E Engineer" });
    await userEdit(r1.reportId, "B", { rtplStatus: "Scheduled", engineer: "E2E Engineer" });
    await userEdit(r1.reportId, "A", { evening: "Attended" });

    console.log("\nDay 1, upload 2 (worker) — chain carries Morning and A's Evening");
    const r2 = await workerCycle(DAY1, "e2e-evw-u2.xlsx");
    check("A Morning carried as Scheduled", reportMorning(r2, "A"), "Scheduled");
    check("B Morning carried as Scheduled", reportMorning(r2, "B"), "Scheduled");
    check("A Evening carried (LIMIT-1 source path)", reportEvening(r2, "A"), "Attended");
    check("B Evening still blank", reportEvening(r2, "B"), null);

    console.log(
      "\nUser sets Evening on B — but on the OLD report 1 (stale tab; the exact prod vector)",
    );
    await userEdit(r1.reportId, "B", { evening: "Case-Closed" });

    console.log("\nDay 1, upload 3 (worker) — B's Evening must survive the LIMIT-1 gap");
    const r3 = await workerCycle(DAY1, "e2e-evw-u3.xlsx");
    check("B Morning still Scheduled", reportMorning(r3, "B"), "Scheduled");
    check("B Evening recovered from the stale-report edit", reportEvening(r3, "B"), "Case-Closed");
    check("A Evening still Attended", reportEvening(r3, "A"), "Attended");
    check("B Evening persisted on the new report", await persistedEvening(r3.reportId, "B"), "Case-Closed");

    console.log("\nRegenerating report 2 — its blank B Evening must be healed in the DB");
    check("report 2 persisted B Evening is blank before regen", await persistedEvening(r2.reportId, "B"), null);
    // Same batch ids -> validateReportGenerationTransaction resolves report 2.
    const r2regen = await generateDailyCallPlanReport({
      reportDate: DAY1,
      generatedBy: userId,
      regionId,
      flexUploadBatchId: createdBatchIds[1]!,
      allowCreate: false,
    });
    check("regen returns report 2", r2regen.reportId, r2.reportId);
    check("regen shows B's Evening", reportEvening(r2regen, "B"), "Case-Closed");
    check("report 2 persisted B Evening healed", await persistedEvening(r2.reportId, "B"), "Case-Closed");
    check("report 2 A Evening untouched", await persistedEvening(r2.reportId, "A"), "Attended");

    console.log(
      "\nUser edits only the ENGINEER on the NEWEST report — must not read as an Evening clear",
    );
    // The 2026-07-30 vector: rows.updated_at is a WHOLE-ROW timestamp, so this
    // edit made the newest report's row (Evening blank, never Evening-edited)
    // look like a deliberate clear made after B's 'Case-Closed' entry — and the
    // next worker cycle dropped B's Evening.
    await userEdit(r3.reportId, "B", { engineer: "E2E Engineer 2" });

    console.log("\nDay 1, upload 4 (worker) — an unrelated edit must not wipe the Evening");
    const r4 = await workerCycle(DAY1, "e2e-evw-u4.xlsx");
    check("B Evening survives an unrelated field edit", reportEvening(r4, "B"), "Case-Closed");
    check("B Morning still Scheduled", reportMorning(r4, "B"), "Scheduled");
    check("A Evening still Attended", reportEvening(r4, "A"), "Attended");

    console.log("\nUser CLEARS A's Evening on the NEWEST report — the clear must stand");
    await userEdit(r4.reportId, "A", { evening: null });

    console.log("\nDay 1, upload 5 (worker) — no resurrection of the cleared Evening");
    const r5 = await workerCycle(DAY1, "e2e-evw-u5.xlsx");
    check("A Evening stays cleared", reportEvening(r5, "A"), null);
    check("B Evening still Case-Closed", reportEvening(r5, "B"), "Case-Closed");

    console.log("\nDay 2, upload 1 — day boundary: Evening promotes to Morning, Evenings blank");
    const r6 = await workerCycle(DAY2, "e2e-evw-d2u1.xlsx");
    check("B Morning promoted from Evening", reportMorning(r6, "B"), "Case-Closed");
    check("A Morning promoted from its Morning (Evening was cleared)", reportMorning(r6, "A"), "Scheduled");
    check("A Evening blank on the new day", reportEvening(r6, "A"), null);
    check("B Evening blank on the new day", reportEvening(r6, "B"), null);

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
