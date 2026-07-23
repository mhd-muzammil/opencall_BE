/**
 * End-to-end test for the engineer-productivity SCHEDULED-GATE model, against the
 * REAL local Postgres, the REAL report generator and the REAL row-edit service
 * (no mocks) — the same pipeline the UI and the Final-EOD freeze run.
 *
 * Rule under test (revised 2026-07-23): a call is Assigned ONLY when its
 * Morning/RTPL status is a scheduling status (Scheduled / To be Scheduled /
 * Engg Assigned) AND an engineer is set. Worked-but-unbooked backlog (an
 * Evening entry or a same-day close on a never-Scheduled call) counts nowhere.
 * For booked calls the Evening status or a same-day closure decides the
 * outcome columns.
 *
 * Scenario (one engineer, mirrors the real 2026-07-23 report):
 *   Day 1 u1: T01..T12 uploaded, report generated.
 *     - T01..T09 scheduled to the engineer (the REAL edit path: engineer +
 *       Scheduled writes the auto "Scheduled on <date>" remark).
 *     - T10, T11 -> SSC Pending + engineer;  T12 -> Customer Pending + engineer
 *       (carried backlog look-alikes: booked to nobody's plan).
 *     - Evening entries: T04 SSC Pending, T05 Under Observation, T06 CX
 *       Pending, T08 Case-Closed, T09 Engineer Delay — plus worked backlog
 *       T10 SSC Pending, T12 Customer Pending.
 *   Day 1 u2: T07 and T11 vanish from Flex -> same-day closed synthetic rows.
 *
 * Expected productivity: Assigned 9 (T01..T09), Attended 4 (T04 part-order,
 * T05 under-observation, T07 same-day close, T08 close), CX 1 (T06),
 * Engineer Delay 1 (T09). T10/T11/T12 are excluded everywhere — under the old
 * "worked today enters the plan" model they inflated Assigned to 12.
 *
 * All data lives under a dedicated throwaway region and is deleted afterwards
 * (also on start, in case a previous run crashed).
 *
 * Run: npx tsx src/scripts/e2eEngineerProductivity.ts
 */
import {
  computeEngineerProductivity,
  type ProductivityReportRow,
} from "@opencall/shared";
import type { PoolClient } from "pg";
import { closeDatabasePool, withTransaction } from "../config/database.js";
import { createUploadBatch } from "../repositories/uploadBatchRepository.js";
import { insertFlexWipRecords } from "../repositories/sourceRecordRepository.js";
import { normalizeTicketId } from "../services/normalization/valueNormalizer.js";
import { generateDailyCallPlanReport } from "../services/callPlanGenerator/dailyCallPlanGenerator.js";
import { updateReportRowManualFields } from "../services/reportRows/reportRowEditService.js";
import type { AuthenticatedUser } from "../types/auth.js";
import type { FlexWipParsedRecord } from "../types/sourceRecords.js";
import type { GeneratedDailyCallPlanReport } from "../types/reportGeneration.js";

const TEST_REGION_CODE = "E2EPROD01";
const ENGINEER = "E2E Lava";
const TICKET = (suffix: string) => `E2E-PRD-${suffix}`;
const DAY1 = "2026-07-20";

const ALL_SUFFIXES = [
  "T01", "T02", "T03", "T04", "T05", "T06",
  "T07", "T08", "T09", "T10", "T11", "T12",
] as const;

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` (expected ${String(expected)}, got ${String(actual)})`}`,
  );
}

function flexRecord(suffix: string, rowNumber: number): FlexWipParsedRecord {
  const ticketId = TICKET(suffix);
  return {
    ticketId,
    normalizedTicketId: normalizeTicketId(ticketId),
    caseId: null,
    normalizedCaseId: null,
    createTime: new Date("2026-07-15T04:30:00.000Z"),
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

/** ticket_id -> persisted row id, straight from the DB (the source of truth). */
async function persistedRowIds(reportId: string): Promise<Map<string, string>> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string; ticket_id: string }>(
      `SELECT id, ticket_id FROM daily_call_plan_report_rows WHERE report_id = $1`,
      [reportId],
    );
    return new Map(result.rows.map((r) => [r.ticket_id, r.id]));
  });
}

function toProductivityRows(
  report: GeneratedDailyCallPlanReport,
): ProductivityReportRow[] {
  return report.rows.map((row) => ({
    serialNo: row.serialNo,
    output: row.output,
    carryForward: {
      closedSyntheticRow: row.carryForward.closedSyntheticRow,
      sameDayClosedRow: row.carryForward.sameDayClosedRow,
    },
    comparison: row.comparison
      ? { previousFlexStatus: row.comparison.previousFlexStatus ?? null }
      : null,
  }));
}

async function run(): Promise<void> {
  const { regionId, user } = await withTransaction(async (client) => {
    await cleanup(client);
    const regionResult = await client.query<{ id: string }>(
      `INSERT INTO regions (code, name, is_active)
       VALUES ($1, 'E2E Engineer Productivity', TRUE)
       ON CONFLICT (code) DO UPDATE SET is_active = TRUE
       RETURNING id`,
      [TEST_REGION_CODE],
    );
    const userResult = await client.query<{
      id: string;
      email: string;
      username: string | null;
    }>(
      `SELECT id, email, username FROM users
        WHERE role = 'SUPER_ADMIN' AND is_active LIMIT 1`,
    );
    const regionRow = regionResult.rows[0];
    const userRow = userResult.rows[0];
    if (!regionRow || !userRow) {
      throw new Error("Setup failed: need a SUPER_ADMIN user and a test region");
    }
    const superAdmin: AuthenticatedUser = {
      id: userRow.id,
      email: userRow.email,
      username: userRow.username,
      role: "SUPER_ADMIN",
      regionId: null,
      region_id: null,
      mustChangePassword: false,
      accessibleSections: null,
    };
    return { regionId: regionRow.id, user: superAdmin };
  });

  const generate = async (
    reportDate: string,
    tickets: readonly string[],
    fileName: string,
  ) => {
    const batchId = await seedUpload(regionId, user.id, fileName, tickets);
    return generateDailyCallPlanReport({
      reportDate,
      generatedBy: user.id,
      regionId,
      flexUploadBatchId: batchId,
      allowCreate: true,
    });
  };

  try {
    console.log("\nDay 1, upload 1 (T01..T12) — generate and book the day's plan");
    const u1 = await generate(DAY1, [...ALL_SUFFIXES], "d1u1.xlsx");
    check("12 rows generated", u1.rows.length, 12);
    const rowIds = await persistedRowIds(u1.reportId);
    check("12 rows persisted", rowIds.size, 12);

    const edit = (suffix: string, values: Record<string, string>) => {
      const rowId = rowIds.get(TICKET(suffix));
      if (!rowId) throw new Error(`No persisted row for ${TICKET(suffix)}`);
      return updateReportRowManualFields({ rowId, user, values });
    };

    // Book T01..T09 through the REAL edit path (engineer + Scheduled in one
    // edit — the server writes the auto "Scheduled on <date>" remark).
    for (const suffix of ["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09"]) {
      const updated = await edit(suffix, { engineer: ENGINEER, rtplStatus: "Scheduled" });
      if (suffix === "T01") {
        check(
          "scheduling wrote the auto 'Scheduled on <date>' remark",
          /^Scheduled on \d{1,2}(st|nd|rd|th) [A-Z][a-z]+$/.test(updated.remarks ?? ""),
          true,
        );
      }
    }

    // Backlog look-alikes: engineer set but never booked.
    await edit("T10", { engineer: ENGINEER, rtplStatus: "SSC Pending" });
    await edit("T11", { engineer: ENGINEER, rtplStatus: "SSC Pending" });
    await edit("T12", { engineer: ENGINEER, rtplStatus: "Customer Pending" });

    // Evening outcomes — on booked calls AND on the worked backlog.
    await edit("T04", { eveningRtplStatus: "SSC Pending" });
    await edit("T05", { eveningRtplStatus: "Under Observation" });
    await edit("T06", { eveningRtplStatus: "CX Pending" });
    await edit("T08", { eveningRtplStatus: "Case-Closed" });
    await edit("T09", { eveningRtplStatus: "Engineer Delay" });
    await edit("T10", { eveningRtplStatus: "SSC Pending" });
    await edit("T12", { eveningRtplStatus: "Customer Pending" });

    console.log("\nDay 1, upload 2 — T07 (booked) and T11 (unbooked) vanish from Flex");
    const u2 = await generate(
      DAY1,
      ALL_SUFFIXES.filter((s) => s !== "T07" && s !== "T11"),
      "d1u2.xlsx",
    );
    const t07 = u2.rows.find((r) => r.enriched.ticket_id === TICKET("T07"));
    const t11 = u2.rows.find((r) => r.enriched.ticket_id === TICKET("T11"));
    check("T07 is a same-day closed row", t07?.carryForward.sameDayClosedRow, true);
    check("T07 kept its Scheduled morning status", t07?.output["RTPL status"], "Scheduled");
    check("T11 is a same-day closed row", t11?.carryForward.sameDayClosedRow, true);

    console.log("\nProductivity (the SAME shared function the dashboard and Final-EOD run)");
    const result = computeEngineerProductivity(toProductivityRows(u2));
    const engineer = result.list.find((e) => e.name === ENGINEER);
    check("exactly one engineer in the table", result.list.length, 1);
    check("Assigned = 9 (the booked plan, not the worked backlog)", engineer?.assigned, 9);
    check("Attended = 4 (T04 part, T05 obs, T07 same-day close, T08 close)", engineer?.attended, 4);
    check("Closed = 2 (T07 vanished, T08 evening-closed)", engineer?.closed, 2);
    check("Part ordered = 1 (T04)", engineer?.partOrdered, 1);
    check("Under observation = 1 (T05)", engineer?.underObservation, 1);
    check("CX Reschedule = 1 (T06)", engineer?.cxReschedule, 1);
    check("Engineer delay = 1 (T09)", engineer?.engineerDelay, 1);
    check("total attended matches", result.totalAttended, 4);

    const assigned = new Set(engineer?.assignedTickets ?? []);
    check("worked SSC backlog (T10) excluded", assigned.has(TICKET("T10")), false);
    check("same-day close of unbooked call (T11) excluded", assigned.has(TICKET("T11")), false);
    check("worked Customer-Pending backlog (T12) excluded", assigned.has(TICKET("T12")), false);
    check("booked same-day close (T07) IS assigned", assigned.has(TICKET("T07")), true);

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
