import type { PoolClient } from "pg";
import { query } from "../config/database.js";
import { syncPartToInventory } from "../services/inventorySyncService.js";
import type {
  GeneratedDailyCallPlanRow,
  GenerateDailyCallPlanInput,
  ManualCarryForwardField,
} from "../types/reportGeneration.js";

interface DailyReportRow {
  id: string;
}

interface InsertedDailyReportRow {
  /** Returned so a chunked multi-row INSERT can pair each result with its own row. */
  serial_no: number | string;
  id: string;
  updated_at: string | null;
  updated_by: string | null;
}

export interface PersistedReportRowMetadata {
  id: string;
  serialNo: number;
  ticketId: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface PersistedReportRowSnapshot extends PersistedReportRowMetadata {
  caseCreatedTime: string | null;
  wipAging: string | null;
  statusAging: string | null;
  hpOwnerStatus: string | null;
  rtplStatus: string | null;
  eveningRtplStatus: string | null;
  segment: string | null;
  engineer: string | null;
  location: string | null;
  customerMail: string | null;
  rca: string | null;
  remarks: string | null;
  manualNotes: string | null;
  carriedForwardFields: ManualCarryForwardField[];
  manualFieldsCompleted: boolean;
  manualFieldsMissing: ManualCarryForwardField[];
  /**
   * When the EVENING status itself was last edited; null = never user-set on
   * this row. updated_at is stamped by every field edit, so it cannot tell a
   * deliberate Evening clear from an unrelated Engineer/Morning/Remarks edit —
   * the same-day Evening rules need this one.
   */
  eveningUpdatedAt: string | null;
  /**
   * Manual fields a user DELIBERATELY emptied on this row. A blank value alone
   * cannot say that — it reads identically to "never filled in", which is what
   * let regeneration re-carry a cleared engineer straight back (migration 046).
   */
  manuallyClearedFields: ManualCarryForwardField[];
  isExcluded: boolean;
}

interface PersistedReportRowSnapshotDbRow {
  id: string;
  serial_no: number;
  ticket_id: string;
  case_created_time: string | null;
  wip_aging: string | null;
  status_aging: string | null;
  hp_owner_status: string | null;
  rtpl_status: string | null;
  evening_rtpl_status: string | null;
  segment: string | null;
  engineer: string | null;
  location: string | null;
  customer_mail: string | null;
  rca: string | null;
  remarks: string | null;
  manual_notes: string | null;
  carried_forward_fields: ManualCarryForwardField[];
  manual_fields_completed: boolean;
  manual_fields_missing: ManualCarryForwardField[];
  updated_at: string | null;
  evening_updated_at: string | null;
  manually_cleared_fields: ManualCarryForwardField[] | null;
  updated_by: string | null;
  is_excluded: boolean;
}

export interface ReportRowEditPayload {
  engineer?: string | null;
  rtplStatus?: string | null;
  eveningRtplStatus?: string | null;
  /**
   * Did the PATCH actually carry an Evening value? Only then is the Evening's
   * own edit timestamp stamped. Every other field edit still stamps updated_at
   * (a whole-row timestamp), which is why it cannot stand in for this: an
   * Engineer edit on a row with a blank Evening used to be indistinguishable
   * from a deliberate Evening clear, and the same-day Evening authority then
   * refused to restore the Evening a user had typed on another of today's
   * reports.
   */
  eveningRtplStatusEdited?: boolean;
  customerMail?: string | null;
  rca?: string | null;
  remarks?: string | null;
  manualNotes?: string | null;
  location?: string | null;
  segment?: string | null;
  caseCreatedTime?: string | null;
  wipAging?: string | null;
  statusAging?: string | null;
  hpOwnerStatus?: string | null;
  part?: string | null;
  clearedCarryForwardFields?: readonly ManualCarryForwardField[];
  /**
   * Manual fields this edit DELIBERATELY emptied, and the ones it gave a real
   * value to. Together they maintain `manually_cleared_fields`: a clear is
   * recorded so regeneration leaves the blank standing, and re-assigning a
   * value drops the field back out. Absent (both undefined) = leave the stored
   * list untouched, which is what every caller predating migration 046 does.
   */
  manuallyClearedFields?: readonly ManualCarryForwardField[];
  manuallySetFields?: readonly ManualCarryForwardField[];
  manualFieldsCompleted: boolean;
  manualFieldsMissing: readonly ManualCarryForwardField[];
  updatedBy: string | null;
  /**
   * Set instead of `updatedBy` when the editor is a special-access credential —
   * `updated_by` is a FK to users(id), which a credential can never satisfy.
   * Regular-user edits leave this undefined and behave exactly as before.
   */
  updatedBySpecialAccess?: string | null;
  updatedByVendorAccess?: string | null;
}

export interface ReportRowCarryForwardBackfillPayload {
  rowId: string;
  rtplStatus: string | null;
  segment: string | null;
  engineer: string | null;
  location: string | null;
  caseCreatedTime: string | null;
  statusAging: string | null;
  hpOwnerStatus: string | null;
  customerMail: string | null;
  rca: string | null;
  remarks: string | null;
  manualNotes: string | null;
  carriedForwardFields: readonly ManualCarryForwardField[];
  manualFieldsCompleted: boolean;
  manualFieldsMissing: readonly ManualCarryForwardField[];
}

// Same shape as the fill-if-empty backfill, minus segment (segment is never
// carried forward — it is recomputed from the source file each run). Used to
// *overwrite* inherited fields whose source value changed after this report was
// generated, so the row is never left showing a stale carried-forward snapshot.
export interface ReportRowCarryForwardOverwritePayload {
  rowId: string;
  rtplStatus: string | null;
  engineer: string | null;
  location: string | null;
  caseCreatedTime: string | null;
  statusAging: string | null;
  hpOwnerStatus: string | null;
  customerMail: string | null;
  rca: string | null;
  remarks: string | null;
  manualNotes: string | null;
  carriedForwardFields: readonly ManualCarryForwardField[];
  manualFieldsCompleted: boolean;
  manualFieldsMissing: readonly ManualCarryForwardField[];
}

export interface EditedReportRow {
  id: string;
  reportId: string;
  serialNo: number;
  ticketId: string;
  caseId: string | null;
  regionId: string | null;
  workLocation: string | null;
  caseCreatedTime: string | null;
  wipAging: string | null;
  statusAging: string | null;
  hpOwnerStatus: string | null;
  engineer: string | null;
  rtplStatus: string | null;
  eveningRtplStatus: string | null;
  customerMail: string | null;
  rca: string | null;
  remarks: string | null;
  manualNotes: string | null;
  location: string | null;
  segment: string | null;
  part: string | null;
  customerName: string | null;
  carriedForwardFields: ManualCarryForwardField[];
  manualFieldsCompleted: boolean;
  manualFieldsMissing: ManualCarryForwardField[];
  updatedAt: string;
  updatedBy: string | null;
  rowEditable: boolean;
  carryForwardSource: "PREVIOUS_FINAL_REPORT";
  rtplStatusChange?: RtplStatusChange | null;
}

export interface RtplStatusChange {
  rowId: string;
  reportId: string;
  serialNo: number;
  ticketId: string;
  caseId: string | null;
  workLocation: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  changedAt: string;
  changedBy: string | null;
}

interface EditedReportRowDbRow {
  id: string;
  report_id: string;
  serial_no: number;
  ticket_id: string;
  case_id: string | null;
  region_id: string | null;
  work_location: string | null;
  case_created_time: string | null;
  wip_aging: string | null;
  status_aging: string | null;
  hp_owner_status: string | null;
  engineer: string | null;
  rtpl_status: string | null;
  evening_rtpl_status: string | null;
  customer_mail: string | null;
  rca: string | null;
  remarks: string | null;
  manual_notes: string | null;
  location: string | null;
  segment: string | null;
  part: string | null;
  customer_name: string | null;
  carried_forward_fields: ManualCarryForwardField[];
  manual_fields_completed: boolean;
  manual_fields_missing: ManualCarryForwardField[];
  updated_at: string;
  updated_by: string | null;
}

export interface FinalReportManualCarryForwardRow {
  serialNo: number;
  ticketId: string;
  caseId: string | null;
  caseCreatedTime: string | null;
  wipAging: string | null;
  statusAging: string | null;
  rtplStatus: string | null;
  eveningRtplStatus: string | null;
  segment: string | null;
  engineer: string | null;
  product: string | null;
  productLineName: string | null;
  workLocation: string | null;
  flexStatus: string | null;
  hpOwnerStatus: string | null;
  woOtcCode: string | null;
  accountName: string | null;
  customerName: string | null;
  customerType: string | null;
  productSerialNo: string | null;
  location: string | null;
  contact: string | null;
  part: string | null;
  wipAgingCategory: string | null;
  tat: string | null;
  customerMail: string | null;
  rca: string | null;
  remarks: string | null;
  manualNotes: string | null;
  flexStatusUnchangedDays: number | null;
  sourceReportDate: string | null;
  /** Was this row already a closed synthetic row in the source report? */
  changeType: string | null;
  /** Was this row closed by a same-day re-upload (i.e. still on the Records page)? */
  sameDayClosed: boolean;
  /**
   * When the source row's EVENING was last edited; null = never user-set on
   * this row. Lets the same-day Evening rule decide whether the source row
   * itself reflects the newest user action on the Evening (incl. an explicit
   * clear) or whether a more recent user-set Evening on ANOTHER same-day
   * report must win. Deliberately NOT rows.updated_at: that is stamped by
   * every field edit, so an Engineer or Remarks edit read as an Evening clear
   * and wiped the value.
   */
  eveningUpdatedAt: string | null;
  manualValues: Partial<Record<ManualCarryForwardField, string | null>>;
}

interface FinalReportManualCarryForwardDbRow {
  serial_no: number;
  ticket_id: string;
  case_id: string | null;
  case_created_time: string | null;
  wip_aging: string | null;
  status_aging: string | null;
  rtpl_status: string | null;
  evening_rtpl_status: string | null;
  segment: string | null;
  engineer: string | null;
  product: string | null;
  product_line_name: string | null;
  work_location: string | null;
  flex_status: string | null;
  hp_owner_status: string | null;
  wo_otc_code: string | null;
  account_name: string | null;
  customer_name: string | null;
  customer_type: string | null;
  product_serial_no: string | null;
  location: string | null;
  contact: string | null;
  part: string | null;
  wip_aging_category: string | null;
  tat: string | null;
  customer_mail: string | null;
  rca: string | null;
  remarks: string | null;
  manual_notes: string | null;
  flex_status_unchanged_days: number | null;
  source_report_date: string | null;
  change_type: string | null;
  same_day_closed: boolean | null;
  evening_updated_at: string | null;
}

function mapFinalReportManualCarryForwardRow(
  row: FinalReportManualCarryForwardDbRow,
): FinalReportManualCarryForwardRow {
  // Typed as the FULL record (not Partial) on purpose: carry-forward reads every
  // declared field through `manualValues`, so a field missing here is silently
  // never carried. `case_created_time` was omitted for months — harmless while
  // the Flex file always supplied it, then every aging went blank the day it
  // didn't. This annotation turns that class of omission into a compile error.
  const manualValues: Record<ManualCarryForwardField, string | null> = {
    rtpl_status: row.rtpl_status,
    segment: row.segment,
    engineer: row.engineer,
    location: row.location,
    case_created_time: row.case_created_time,
    status_aging: row.status_aging,
    hp_owner_status: row.hp_owner_status,
    customer_mail: row.customer_mail,
    rca: row.rca,
    remarks: row.remarks,
    manual_notes: row.manual_notes,
  };

  return {
    serialNo: row.serial_no,
    ticketId: row.ticket_id,
    caseId: row.case_id,
    caseCreatedTime: row.case_created_time,
    wipAging: row.wip_aging,
    statusAging: row.status_aging,
    rtplStatus: row.rtpl_status,
    eveningRtplStatus: row.evening_rtpl_status,
    segment: row.segment,
    engineer: row.engineer,
    product: row.product,
    productLineName: row.product_line_name,
    workLocation: row.work_location,
    flexStatus: row.flex_status,
    hpOwnerStatus: row.hp_owner_status,
    woOtcCode: row.wo_otc_code,
    accountName: row.account_name,
    customerName: row.customer_name,
    customerType: row.customer_type,
    productSerialNo: row.product_serial_no,
    location: row.location,
    contact: row.contact,
    part: row.part,
    wipAgingCategory: row.wip_aging_category,
    tat: row.tat,
    customerMail: row.customer_mail,
    rca: row.rca,
    remarks: row.remarks,
    manualNotes: row.manual_notes,
    flexStatusUnchangedDays: row.flex_status_unchanged_days,
    sourceReportDate: row.source_report_date,
    changeType: row.change_type,
    sameDayClosed: row.same_day_closed ?? false,
    eveningUpdatedAt: row.evening_updated_at ?? null,
    manualValues,
  };
}

function mapEditedReportRow(row: EditedReportRowDbRow): EditedReportRow {
  return {
    id: row.id,
    reportId: row.report_id,
    serialNo: row.serial_no,
    ticketId: row.ticket_id,
    caseId: row.case_id,
    regionId: row.region_id,
    workLocation: row.work_location,
    caseCreatedTime: row.case_created_time,
    wipAging: row.wip_aging,
    statusAging: row.status_aging,
    hpOwnerStatus: row.hp_owner_status,
    engineer: row.engineer,
    rtplStatus: row.rtpl_status,
    eveningRtplStatus: row.evening_rtpl_status,
    customerMail: row.customer_mail,
    rca: row.rca,
    remarks: row.remarks,
    manualNotes: row.manual_notes,
    location: row.location,
    segment: row.segment,
    part: row.part,
    customerName: row.customer_name,
    carriedForwardFields: row.carried_forward_fields,
    manualFieldsCompleted: row.manual_fields_completed,
    manualFieldsMissing: row.manual_fields_missing,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    rowEditable: true,
    carryForwardSource: "PREVIOUS_FINAL_REPORT",
  };
}

function mapPersistedReportRowMetadata(
  row: PersistedReportRowSnapshotDbRow,
): PersistedReportRowSnapshot {
  return {
    id: row.id,
    serialNo: row.serial_no,
    ticketId: row.ticket_id,
    caseCreatedTime: row.case_created_time,
    wipAging: row.wip_aging,
    statusAging: row.status_aging,
    hpOwnerStatus: row.hp_owner_status,
    rtplStatus: row.rtpl_status,
    eveningRtplStatus: row.evening_rtpl_status,
    segment: row.segment,
    engineer: row.engineer,
    location: row.location,
    customerMail: row.customer_mail,
    rca: row.rca,
    remarks: row.remarks,
    manualNotes: row.manual_notes,
    carriedForwardFields: row.carried_forward_fields,
    manualFieldsCompleted: row.manual_fields_completed,
    manualFieldsMissing: row.manual_fields_missing,
    updatedAt: row.updated_at,
    eveningUpdatedAt: row.evening_updated_at ?? null,
    manuallyClearedFields: row.manually_cleared_fields ?? [],
    updatedBy: row.updated_by,
    isExcluded: row.is_excluded,
  };
}

export async function createDailyCallPlanReport(
  client: PoolClient,
  input: GenerateDailyCallPlanInput,
  totals: {
    totalRows: number;
    duplicateTicketCount: number;
    unmatchedTicketCount: number;
  },
): Promise<string> {
  const result = await client.query<DailyReportRow>(
    `
      INSERT INTO daily_call_plan_reports (
        report_date,
        region_id,
        generated_by,
        flex_upload_batch_id,
        renderways_upload_batch_id,
        call_plan_upload_batch_id,
        total_rows,
        duplicate_ticket_count,
        unmatched_ticket_count
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `,
    [
      input.reportDate,
      input.regionId,
      input.generatedBy,
      input.flexUploadBatchId,
      input.renderwaysUploadBatchId ?? null,
      input.callPlanUploadBatchId ?? null,
      totals.totalRows,
      totals.duplicateTicketCount,
      totals.unmatchedTicketCount,
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Daily call plan report insert did not return a row");
  }

  return row.id;
}

/** Highest persisted serial_no for a report (0 when the report has no rows). */
export async function findMaxDailyCallPlanReportRowSerialNo(
  client: PoolClient,
  reportId: string,
): Promise<number> {
  const result = await client.query<{ max_serial: number | string | null }>(
    `
      SELECT MAX(serial_no) AS max_serial
      FROM daily_call_plan_report_rows
      WHERE report_id = $1
    `,
    [reportId],
  );
  return Number(result.rows[0]?.max_serial ?? 0);
}

/**
 * Columns of `daily_call_plan_report_rows` written at generation, in parameter order.
 *
 * Kept beside the value builder below so the two cannot drift: a column added to one
 * and not the other is a compile error, not a runtime `INSERT has more target columns
 * than expressions`.
 */
const REPORT_ROW_INSERT_COLUMNS = [
  "report_id",
  "serial_no",
  "ticket_id",
  "case_id",
  "case_created_time",
  "wip_aging",
  "status_aging",
  "rtpl_status",
  "evening_rtpl_status",
  "segment",
  "engineer",
  "product",
  "product_line_name",
  "work_location",
  "flex_status",
  "hp_owner_status",
  "wo_otc_code",
  "account_name",
  "customer_name",
  "customer_type",
  "product_serial_no",
  "location",
  "contact",
  "part",
  "wip_aging_category",
  "tat",
  "customer_mail",
  "rca",
  "remarks",
  "manual_notes",
  "change_type",
  "previous_flex_status",
  "previous_rtpl_status",
  "previous_wip_aging",
  "changed_fields",
  "change_summary",
  "carried_forward_fields",
  "manual_fields_completed",
  "manual_fields_missing",
  "match_status",
  "match_notes",
  "flex_status_unchanged_days",
  "same_day_closed",
  "distance_km",
  "distance_bearing",
] as const;

/** Casts the placeholders that need one, by 1-based position in the list above. */
const REPORT_ROW_INSERT_CASTS: Readonly<Record<number, string>> = {
  35: "::jsonb", // changed_fields
  37: "::jsonb", // carried_forward_fields
  39: "::text[]", // manual_fields_missing
  41: "::jsonb", // match_notes
};

function reportRowInsertValues(
  reportId: string,
  row: GeneratedDailyCallPlanRow,
): unknown[] {
  return [
    reportId,
    row.serialNo,
    row.enriched.ticket_id,
    row.enriched.case_id || null,
    row.enriched.case_created_time,
    row.enriched.wip_aging,
    row.enriched.status_aging,
    row.enriched.rtpl_status,
    row.enriched.evening_rtpl_status ?? null,
    row.enriched.segment,
    row.enriched.engineer,
    row.enriched.product,
    row.enriched.product_line_name,
    row.enriched.work_location,
    row.enriched.flex_status,
    row.enriched.hp_owner_status,
    row.enriched.wo_otc_code,
    row.enriched.account_name,
    row.enriched.customer_name,
    row.enriched.customer_type,
    row.enriched.product_serial_no,
    row.enriched.location,
    row.enriched.contact,
    row.enriched.part,
    row.enriched.wip_aging_category,
    row.enriched.tat,
    row.enriched.customer_mail,
    row.enriched.rca,
    row.enriched.remarks,
    row.enriched.manual_notes,
    row.comparison?.changeType ?? null,
    row.comparison?.previousFlexStatus ?? null,
    row.comparison?.previousRtplStatus ?? null,
    row.comparison?.previousWipAging ?? null,
    JSON.stringify(row.comparison?.changedFields ?? {}),
    row.comparison?.changeSummary ?? null,
    JSON.stringify(row.carryForward.carriedForwardFields),
    row.carryForward.manualFieldsCompleted,
    row.carryForward.manualFieldsMissing,
    row.enriched.match_status,
    JSON.stringify(row.match.notes),
    row.comparison?.flexStatusUnchangedDays ?? null,
    row.carryForward.sameDayClosedRow,
    row.enriched.distance_km,
    row.enriched.distance_bearing,
  ];
}

/**
 * Rows per INSERT statement.
 *
 * Postgres caps a statement at 65535 bound parameters; at 45 columns that is 1456 rows.
 * 400 keeps a comfortable margin and bounds the size of any single statement.
 */
const REPORT_ROW_INSERT_CHUNK = 400;

/**
 * Persists a report's rows.
 *
 * Written as chunked multi-row INSERTs rather than one statement per row. A full
 * production report is several thousand rows, and one round-trip each ran them
 * strictly serially inside the generation transaction — which holds
 * `pg_advisory_xact_lock` for its whole duration, so every other generation of the
 * same report queued behind it. The work is identical; it is the round-trips that
 * were the cost.
 *
 * `RETURNING` is mapped back by `serial_no` (UNIQUE per report) rather than by result
 * position: Postgres does not promise that a multi-row INSERT returns rows in VALUES
 * order, and silently pairing a row with another row's id would mis-attribute every
 * later edit.
 */
export async function insertDailyCallPlanReportRows(
  client: PoolClient,
  reportId: string,
  rows: readonly GeneratedDailyCallPlanRow[],
): Promise<void> {
  const columnList = REPORT_ROW_INSERT_COLUMNS.join(",\n          ");

  for (let offset = 0; offset < rows.length; offset += REPORT_ROW_INSERT_CHUNK) {
    const chunk = rows.slice(offset, offset + REPORT_ROW_INSERT_CHUNK);
    const values: unknown[] = [];
    const tuples: string[] = [];

    for (const row of chunk) {
      const rowValues = reportRowInsertValues(reportId, row);
      const placeholders = rowValues.map((_, index) => {
        const position = index + 1;
        return `$${values.length + position}${REPORT_ROW_INSERT_CASTS[position] ?? ""}`;
      });
      values.push(...rowValues);
      tuples.push(`(${placeholders.join(", ")})`);
    }

    const result = await client.query<InsertedDailyReportRow>(
      `
        INSERT INTO daily_call_plan_report_rows (
          ${columnList}
        )
        VALUES
        ${tuples.join(",\n        ")}
        RETURNING
          serial_no,
          id,
          updated_at::TEXT AS updated_at,
          updated_by::TEXT AS updated_by
      `,
      values,
    );

    const insertedBySerial = new Map(
      result.rows.map((inserted) => [Number(inserted.serial_no), inserted]),
    );

    for (const row of chunk) {
      const inserted = insertedBySerial.get(row.serialNo);
      if (!inserted) {
        throw new Error("Daily call plan report row insert did not return a row");
      }

      row.id = inserted.id;
      row.updatedAt = inserted.updated_at;
      row.updatedBy = inserted.updated_by;

      if (row.enriched.case_id && row.enriched.part) {
        syncPartToInventory({
          case_id: row.enriched.case_id,
          ticket_id: row.enriched.ticket_id,
          part: row.enriched.part,
          work_location: row.enriched.work_location,
          engineer: row.enriched.engineer,
          customer_name: row.enriched.customer_name,
        });
      }
    }
  }
}

export async function findDailyCallPlanReportRowMetadataByReportId(
  client: PoolClient,
  reportId: string,
): Promise<PersistedReportRowSnapshot[]> {
  const result = await client.query<PersistedReportRowSnapshotDbRow>(
    `
      SELECT
        id,
        serial_no,
        ticket_id,
        case_created_time::TEXT AS case_created_time,
        wip_aging,
        status_aging,
        hp_owner_status,
        rtpl_status,
        evening_rtpl_status,
        segment,
        engineer,
        location,
        customer_mail,
        rca,
        remarks,
        manual_notes,
        carried_forward_fields,
        manual_fields_completed,
        manual_fields_missing,
        updated_at::TEXT AS updated_at,
        -- NOT COALESCEd onto updated_at: see the same column in
        -- findPreviousFinalReportRowsForManualCarryForward.
        evening_rtpl_status_updated_at::TEXT AS evening_updated_at,
        manually_cleared_fields,
        updated_by::TEXT AS updated_by,
        is_excluded
      FROM daily_call_plan_report_rows
      WHERE report_id = $1
      ORDER BY serial_no ASC, id ASC
    `,
    [reportId],
  );

  return result.rows.map(mapPersistedReportRowMetadata);
}

/**
 * The minimal PERSISTED row fields the engineer-productivity calculation
 * needs. Reading these (instead of regenerating the report) is what keeps the
 * Final-EOD freeze and the productivity endpoint strictly READ-ONLY: closing a
 * region's day must never rewrite the day's report (regenerating from a
 * region-scoped Flex batch is how the 2026-07-23 mass-close happened).
 */
export interface ProductivityPersistedRow {
  serialNo: number;
  ticketId: string;
  engineer: string;
  rtplStatus: string;
  eveningRtplStatus: string;
  workLocation: string;
  flexStatus: string;
  closedSyntheticRow: boolean;
  sameDayClosedRow: boolean;
}

/** Everything about a ticket that a field engineer needs on their phone. */
export interface TicketDetailRow {
  ticketId: string;
  caseId: string;
  wipAging: string;
  location: string;
  engineer: string;
  productName: string;
  productSerialNo: string;
  productLineName: string;
  workLocation: string;
  accountName: string;
  customerName: string;
  contact: string;
  customerMail: string;
  // Only the Flex WIP record carries these, and they are the ones that actually
  // say where to go — the report's own Work Location is an ASP code.
  customerAddress: string;
  commonAddress: string;
  customerPincode: string;
}

/**
 * Per-ticket detail for the day's report, keyed by ticket id.
 *
 * The report row holds the operational columns; the postal address and pincode
 * live only on the Flex WIP record, so the latest one per ticket is joined in.
 * The join normalises the ticket id the same way the matching engine does
 * (upper case, non-alphanumerics stripped) rather than trusting the raw text.
 *
 * `onlyTickets` narrows it to the tickets the caller is actually going to read.
 * The lateral join costs a lookup PER ROW, so asking for a whole 3,800-row
 * report to use a few dozen of them is most of the query's cost thrown away —
 * and it was enough cost to cross statement_timeout and stop the Payroll sync
 * outright. Omit it and every row comes back, exactly as before.
 */
export async function findTicketDetailsByReportId(
  reportId: string,
  onlyTickets?: readonly string[],
): Promise<Map<string, TicketDetailRow>> {
  // Normalised the same way the returned map is keyed and the index is built
  // (daily_call_plan_report_rows_ticket_upper_id_idx is on UPPER(TRIM(...))),
  // so the filter can be served from the index instead of scanning.
  const wanted = onlyTickets
    ? [...new Set(onlyTickets.map((t) => t.trim().toUpperCase()).filter(Boolean))]
    : null;
  // An explicit but EMPTY list means the caller wants nothing, which is not the
  // same as not asking — returning the whole report there would be the bug this
  // parameter exists to fix.
  if (wanted && wanted.length === 0) {
    return new Map<string, TicketDetailRow>();
  }
  const result = await query<{
    ticket_id: string | null;
    case_id: string | null;
    wip_aging: string | null;
    location: string | null;
    engineer: string | null;
    product: string | null;
    product_serial_no: string | null;
    product_line_name: string | null;
    work_location: string | null;
    account_name: string | null;
    customer_name: string | null;
    contact: string | null;
    customer_mail: string | null;
    customer_address: string | null;
    common_address: string | null;
    customer_pincode: string | null;
  }>(
    `
      SELECT
        r.ticket_id,
        r.case_id,
        r.wip_aging,
        r.location,
        r.engineer,
        r.product,
        r.product_serial_no,
        r.product_line_name,
        r.work_location,
        r.account_name,
        r.customer_name,
        r.contact,
        r.customer_mail,
        f.customer_address,
        f.common_address,
        f.customer_pincode
      FROM daily_call_plan_report_rows r
      LEFT JOIN LATERAL (
        SELECT customer_address, common_address, customer_pincode
        FROM flex_wip_records w
        WHERE w.normalized_ticket_id =
          regexp_replace(UPPER(COALESCE(r.ticket_id, '')), '[^A-Z0-9]', '', 'g')
        ORDER BY w.created_at DESC
        LIMIT 1
      ) f ON TRUE
      WHERE r.report_id = $1 AND NOT r.is_excluded
        ${wanted ? "AND UPPER(TRIM(r.ticket_id)) = ANY($2::text[])" : ""}
      ORDER BY r.serial_no ASC, r.id ASC
    `,
    wanted ? [reportId, wanted] : [reportId],
  );

  const text = (value: string | null) => (value ?? "").trim();
  const byTicket = new Map<string, TicketDetailRow>();
  for (const row of result.rows) {
    const ticketId = text(row.ticket_id);
    if (!ticketId) {
      continue;
    }
    byTicket.set(ticketId, {
      ticketId,
      caseId: text(row.case_id),
      wipAging: text(row.wip_aging),
      location: text(row.location),
      engineer: text(row.engineer),
      productName: text(row.product),
      productSerialNo: text(row.product_serial_no),
      productLineName: text(row.product_line_name),
      workLocation: text(row.work_location),
      accountName: text(row.account_name),
      customerName: text(row.customer_name),
      contact: text(row.contact),
      customerMail: text(row.customer_mail),
      customerAddress: text(row.customer_address),
      commonAddress: text(row.common_address),
      customerPincode: text(row.customer_pincode),
    });
  }
  return byTicket;
}

export async function findProductivityRowsByReportId(
  reportId: string,
): Promise<ProductivityPersistedRow[]> {
  const result = await query<{
    serial_no: number;
    ticket_id: string | null;
    engineer: string | null;
    rtpl_status: string | null;
    evening_rtpl_status: string | null;
    work_location: string | null;
    flex_status: string | null;
    change_type: string | null;
    same_day_closed: boolean | null;
  }>(
    `
      SELECT
        serial_no,
        ticket_id,
        engineer,
        rtpl_status,
        evening_rtpl_status,
        work_location,
        flex_status,
        change_type::TEXT AS change_type,
        same_day_closed
      FROM daily_call_plan_report_rows
      WHERE report_id = $1 AND NOT is_excluded
      ORDER BY serial_no ASC, id ASC
    `,
    [reportId],
  );

  return result.rows.map((row) => ({
    serialNo: row.serial_no,
    ticketId: row.ticket_id ?? "",
    engineer: row.engineer ?? "",
    rtplStatus: row.rtpl_status ?? "",
    eveningRtplStatus: row.evening_rtpl_status ?? "",
    workLocation: row.work_location ?? "",
    flexStatus: row.flex_status ?? "",
    closedSyntheticRow: row.change_type === "CLOSED",
    sameDayClosedRow: row.same_day_closed === true,
  }));
}

export async function findPreviousFinalReportRowsForManualCarryForward(
  client: PoolClient,
  input: {
    reportDate: string;
    // The report currently being (re)generated, so carry-forward never sources
    // from itself. Null when generating a brand-new report.
    excludeReportId?: string | null;
  },
): Promise<FinalReportManualCarryForwardRow[]> {
  const result = await client.query<FinalReportManualCarryForwardDbRow>(
    `
      WITH completed_sessions AS (
        SELECT
          sessions.id,
          sessions.created_at,
          reports.id AS report_id,
          COALESCE(
            reports.report_date,
            CASE
              WHEN title_date.parts IS NULL THEN NULL
              ELSE make_date(
                (title_date.parts)[3]::INT,
                (title_date.parts)[1]::INT,
                (title_date.parts)[2]::INT
              )
            END
          ) AS effective_report_date
        FROM report_history_sessions sessions
        JOIN daily_call_plan_reports reports
          ON reports.id = sessions.daily_call_plan_report_id
        LEFT JOIN LATERAL regexp_match(
          sessions.title,
          'Report Session\s+([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})'
        ) AS title_date(parts) ON TRUE
        WHERE sessions.status = 'COMPLETED'
          AND sessions.daily_call_plan_report_id IS NOT NULL
        -- Deliberately NOT filtered by sessions.region_id: completed reports
        -- are shared all-region artifacts (each report row set spans every
        -- region; region-scoped uploads retain out-of-scope rows). Filtering
        -- by the requester's region hid today's earlier report whenever a
        -- different admin (different region selection) uploaded next, so
        -- carry-forward fell back to a PRIOR day and the day-boundary rule
        -- wiped every Evening entered earlier today.
      ),
      previous_session AS (
        SELECT id, effective_report_date
        FROM completed_sessions
        -- On or before today: multiple reports are uploaded per day, and each
        -- new report must inherit the accumulated manual work from the most
        -- recent prior report (e.g. this morning's), not just yesterday's.
        WHERE effective_report_date <= $1::date
          AND ($2::text IS NULL OR report_id::text <> $2::text)
        -- Prefer the latest report: newest date, then newest UPLOAD. Ordering
        -- by created_at (not updated_at) keeps the true latest report the
        -- source even after an older same-day report is reopened (reopening
        -- bumps updated_at, which used to promote a stale report over the one
        -- holding the day's Evening work).
        ORDER BY effective_report_date DESC, created_at DESC, id DESC
        LIMIT 1
      )
      SELECT
        rows.serial_no,
        rows.ticket_id,
        rows.case_id,
        rows.case_created_time::TEXT AS case_created_time,
        rows.wip_aging,
        rows.status_aging,
        rows.rtpl_status,
        rows.evening_rtpl_status,
        rows.segment,
        rows.engineer,
        rows.product,
        rows.product_line_name,
        rows.work_location,
        rows.flex_status,
        rows.hp_owner_status,
        rows.wo_otc_code,
        rows.account_name,
        rows.customer_name,
        rows.customer_type,
        rows.product_serial_no,
        rows.location,
        rows.contact,
        rows.part,
        rows.wip_aging_category,
        rows.tat::TEXT AS tat,
        rows.customer_mail,
        rows.rca,
        rows.remarks,
        rows.manual_notes,
        rows.flex_status_unchanged_days,
        rows.change_type::TEXT AS change_type,
        rows.same_day_closed,
        -- NOT COALESCEd onto updated_at: a source row whose Evening was never
        -- user-set must NOT out-vote the same-day authority just because some
        -- other field on it was edited. Migration 040 backfilled the existing
        -- rows, so historical rows still compare on the timestamp they do today.
        rows.evening_rtpl_status_updated_at::TEXT AS evening_updated_at,
        previous_session.effective_report_date::text AS source_report_date
      FROM previous_session
      JOIN report_history_sessions sessions
        ON sessions.id = previous_session.id
      JOIN daily_call_plan_report_rows rows
        ON rows.report_id = sessions.daily_call_plan_report_id
      WHERE NOT rows.is_excluded
      ORDER BY rows.serial_no ASC, rows.id ASC
    `,
    [input.reportDate, input.excludeReportId ?? null],
  );

  return result.rows.map(mapFinalReportManualCarryForwardRow);
}

/**
 * One user-set same-day Evening (EOD) status: a report row a user actually
 * edited (updated_at stamped — generation-written rows never stamp it) whose
 * Evening is non-blank, from ANY of the given date's reports. Ordered
 * most-recently-edited first, so the first row per ticket is the user's
 * newest Evening state for that ticket today.
 */
export interface SameDayUserSetEveningRow {
  ticketId: string;
  eveningRtplStatus: string | null;
  /** When the Evening holding this value was last edited (pg text). */
  eveningUpdatedAt: string;
}

/**
 * Every user-touched, non-blank Evening status across ALL of `reportDate`'s
 * reports. Multiple reports exist per day (each upload — incl. the FieldEZ
 * auto-sync worker's — creates one) and users can be typing into a report
 * that is no longer the newest (stale tab, worker churn, in-flight
 * generation). Carry-forward sources rows from only ONE report (LIMIT 1), so
 * without this an Evening entered on any other same-day report silently
 * vanished from every later report — the "Evening status disappears against
 * Scheduled cases" wipe. Generation merges these as the same-day Evening
 * authority: a user-set Evening must survive every later same-day
 * upload/regeneration, whichever report it was entered on.
 */
export async function findSameDayUserSetEveningRows(
  client: PoolClient,
  input: { reportDate: string },
): Promise<SameDayUserSetEveningRow[]> {
  const result = await client.query<{
    ticket_id: string;
    evening_rtpl_status: string | null;
    evening_updated_at: string;
  }>(
    `
      SELECT
        rows.ticket_id,
        rows.evening_rtpl_status,
        -- COALESCEd here (unlike the carry-forward source query): every row
        -- this query returns already holds a non-blank Evening, so the
        -- whole-row timestamp is a safe estimate of when it was set, and the
        -- authority keeps working for rows written before migration 040 even
        -- if the backfill were ever skipped.
        COALESCE(rows.evening_rtpl_status_updated_at, rows.updated_at)::TEXT
          AS evening_updated_at
      FROM daily_call_plan_report_rows rows
      JOIN daily_call_plan_reports reports
        ON reports.id = rows.report_id
      WHERE reports.report_date = $1::date
        AND rows.updated_at IS NOT NULL
        AND NOT rows.is_excluded
        AND NULLIF(TRIM(COALESCE(rows.evening_rtpl_status, '')), '') IS NOT NULL
      -- Newest EVENING edit first, on the same clock the carry-forward rules
      -- compare against: ordering by the whole-row updated_at let an unrelated
      -- edit on one report promote its older Evening over a newer one entered
      -- elsewhere today.
      ORDER BY COALESCE(rows.evening_rtpl_status_updated_at, rows.updated_at) DESC,
               rows.id DESC
    `,
    [input.reportDate],
  );

  return result.rows.map((row) => ({
    ticketId: row.ticket_id,
    eveningRtplStatus: row.evening_rtpl_status,
    eveningUpdatedAt: row.evening_updated_at,
  }));
}

/** One ticket's Flex Status within a prior report. */
export interface FlexStatusHistoryEntry {
  ticketId: string;
  flexStatus: string | null;
}

/** One prior report (its date + every ticket's Flex Status that day). */
export interface FlexStatusHistoryReport {
  /** Effective report date, `YYYY-MM-DD`. */
  reportDate: string;
  entries: FlexStatusHistoryEntry[];
}

interface FlexStatusHistoryDbRow {
  rank: number;
  report_date: string;
  ticket_id: string;
  flex_status: string | null;
}

/**
 * Returns the Flex Status of every ticket across prior completed reports for the
 * same region, collapsed to one report per calendar day and ordered most-recent
 * first (index 0 = the most recent prior report). Each report carries its date so
 * the unchanged-days counter can measure real calendar days (bridging the gaps
 * between non-daily reports) rather than just counting reports.
 */
export async function findFlexStatusHistoryForUnchangedDays(
  client: PoolClient,
  input: {
    reportDate: string;
    regionId: string | null;
    maxReports?: number;
  },
): Promise<FlexStatusHistoryReport[]> {
  const maxReports =
    input.maxReports && input.maxReports > 0 ? input.maxReports : 120;

  const result = await client.query<FlexStatusHistoryDbRow>(
    `
      WITH completed_sessions AS (
        SELECT
          sessions.id,
          sessions.updated_at,
          COALESCE(
            reports.report_date,
            CASE
              WHEN title_date.parts IS NULL THEN NULL
              ELSE make_date(
                (title_date.parts)[3]::INT,
                (title_date.parts)[1]::INT,
                (title_date.parts)[2]::INT
              )
            END
          ) AS effective_report_date
        FROM report_history_sessions sessions
        JOIN daily_call_plan_reports reports
          ON reports.id = sessions.daily_call_plan_report_id
        LEFT JOIN LATERAL regexp_match(
          sessions.title,
          'Report Session\s+([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})'
        ) AS title_date(parts) ON TRUE
        WHERE sessions.status = 'COMPLETED'
          AND sessions.daily_call_plan_report_id IS NOT NULL
          AND sessions.region_id IS NOT DISTINCT FROM $2
      ),
      daily_sessions AS (
        SELECT DISTINCT ON (effective_report_date)
          id,
          effective_report_date
        FROM completed_sessions
        WHERE effective_report_date < $1::date
        ORDER BY effective_report_date DESC, updated_at DESC, id ASC
      ),
      ranked_sessions AS (
        SELECT
          id,
          effective_report_date,
          ROW_NUMBER() OVER (ORDER BY effective_report_date DESC) AS rank
        FROM daily_sessions
        ORDER BY effective_report_date DESC
        LIMIT $3
      )
      SELECT
        ranked_sessions.rank,
        ranked_sessions.effective_report_date::TEXT AS report_date,
        rows.ticket_id,
        rows.flex_status
      FROM ranked_sessions
      JOIN report_history_sessions sessions
        ON sessions.id = ranked_sessions.id
      JOIN daily_call_plan_report_rows rows
        ON rows.report_id = sessions.daily_call_plan_report_id
      WHERE NOT rows.is_excluded
      ORDER BY ranked_sessions.rank ASC, rows.serial_no ASC, rows.id ASC
    `,
    [input.reportDate, input.regionId, maxReports],
  );

  // Group the flat rows into one bucket per prior report, preserving the
  // most-recent-first ordering carried by `rank` (1-based and gapless).
  const reports: FlexStatusHistoryReport[] = [];
  for (const row of result.rows) {
    const index = Number(row.rank) - 1;
    let bucket = reports[index];
    if (!bucket) {
      bucket = { reportDate: row.report_date, entries: [] };
      reports[index] = bucket;
    }
    bucket.entries.push({ ticketId: row.ticket_id, flexStatus: row.flex_status });
  }

  return reports;
}

export async function updateDailyCallPlanReportRowManualFields(
  rowId: string,
  edit: ReportRowEditPayload,
): Promise<EditedReportRow | null> {
  const result = await query<EditedReportRowDbRow>(
    `
      UPDATE daily_call_plan_report_rows rows
      SET
        engineer = $2,
        -- rtpl_status and segment are NOT NULL columns whose blank
        -- representation is '' (that is what the generator writes and what
        -- the UI renders as "Entry"), so a cleared value lands as '' here.
        rtpl_status = COALESCE($3, ''),
        customer_mail = $4,
        rca = $5,
        remarks = $6,
        manual_notes = $7,
        location = $8,
        segment = COALESCE($9, ''),
        case_created_time = $10,
        wip_aging = $11,
        status_aging = $12,
        hp_owner_status = $13,
        part = $14,
        evening_rtpl_status = $19,
        -- Stamped ONLY by an edit that actually carried an Evening value, so a
        -- deliberate clear is distinguishable from an Engineer/Morning/Remarks
        -- edit on a row whose Evening happens to be blank. updated_at below is
        -- still stamped by every edit — other logic depends on that.
        evening_rtpl_status_updated_at = CASE
          WHEN $22::bool THEN NOW()
          ELSE rows.evening_rtpl_status_updated_at
        END,
        carried_forward_fields = COALESCE(
          (
            SELECT jsonb_agg(field)
            FROM jsonb_array_elements_text(rows.carried_forward_fields) AS field
            WHERE NOT (field = ANY($15::text[]))
          ),
          '[]'::jsonb
        ),
        -- The user's clear/assign intent, not a guess from the value: fields
        -- this edit emptied are added, fields it gave a value to are removed.
        -- applyPersistedRowMetadata reads this to keep a deliberate blank
        -- blank instead of re-carrying the previous report's value over it.
        manually_cleared_fields = COALESCE(
          (
            SELECT jsonb_agg(merged.field)
            FROM (
              SELECT field
              FROM jsonb_array_elements_text(rows.manually_cleared_fields) AS field
              WHERE NOT (field = ANY($24::text[]))
              UNION
              SELECT unnest($23::text[])
            ) AS merged(field)
          ),
          '[]'::jsonb
        ),
        manual_fields_completed = $16,
        manual_fields_missing = $17::text[],
        updated_at = NOW(),
        updated_by = $18,
        updated_by_special_access = $20,
        updated_by_vendor_access = $21
      FROM daily_call_plan_reports reports
      WHERE rows.id = $1
        AND reports.id = rows.report_id
      RETURNING
        rows.id,
        rows.report_id,
        rows.serial_no,
        rows.ticket_id,
        rows.case_id,
        reports.region_id::TEXT AS region_id,
        rows.work_location,
        rows.case_created_time::TEXT AS case_created_time,
        rows.wip_aging,
        rows.status_aging,
        rows.hp_owner_status,
        rows.engineer,
        rows.rtpl_status,
        rows.evening_rtpl_status,
        rows.customer_mail,
        rows.rca,
        rows.remarks,
        rows.manual_notes,
        rows.location,
        rows.segment,
        rows.part,
        rows.customer_name,
        rows.carried_forward_fields,
        rows.manual_fields_completed,
        rows.manual_fields_missing,
        rows.updated_at::TEXT AS updated_at,
        rows.updated_by::TEXT AS updated_by
    `,
    [
      rowId,
      edit.engineer,
      edit.rtplStatus,
      edit.customerMail,
      edit.rca,
      edit.remarks,
      edit.manualNotes,
      edit.location,
      edit.segment,
      edit.caseCreatedTime,
      edit.wipAging,
      edit.statusAging,
      edit.hpOwnerStatus,
      edit.part,
      edit.clearedCarryForwardFields ?? [],
      edit.manualFieldsCompleted,
      edit.manualFieldsMissing,
      edit.updatedBy,
      edit.eveningRtplStatus,
      edit.updatedBySpecialAccess ?? null,
      edit.updatedByVendorAccess ?? null,
      edit.eveningRtplStatusEdited ?? false,
      edit.manuallyClearedFields ?? [],
      edit.manuallySetFields ?? [],
    ],
  );

  const row = result.rows[0];
  const mapped = row ? mapEditedReportRow(row) : null;
  if (mapped && mapped.caseId && mapped.part) {
    syncPartToInventory({
      case_id: mapped.caseId,
      ticket_id: mapped.ticketId,
      part: mapped.part,
      work_location: mapped.workLocation,
      engineer: mapped.engineer,
      customer_name: mapped.customerName,
    });
  }
  return mapped;
}

/**
 * Rows per batched UPDATE. Each carries one small JSON document, so this is about
 * keeping any single statement bounded rather than about the parameter cap.
 */
const REPORT_ROW_UPDATE_CHUNK = 500;

async function inChunks<T>(
  items: readonly T[],
  run: (chunk: readonly T[]) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += REPORT_ROW_UPDATE_CHUNK) {
    await run(items.slice(offset, offset + REPORT_ROW_UPDATE_CHUNK));
  }
}

/**
 * The same-day Evening heal, for many rows at once.
 *
 * Every guard is still evaluated per row, by the same SQL that ran when this was one
 * statement per row — but in a single round-trip rather than one each. It
 * runs inside the generation transaction, which holds `pg_advisory_xact_lock`, so its
 * duration is time every other generation of the same report spends waiting.
 */
export async function adoptReportRowEveningStatusFromAuthorityBulk(
  client: PoolClient,
  payloads: readonly {
    rowId: string;
    eveningRtplStatus: string;
    authorityEveningUpdatedAt: string | null;
  }[],
): Promise<void> {
  if (payloads.length === 0) return;

  await inChunks(payloads, async (chunk) => {
    await client.query(
      `
        UPDATE daily_call_plan_report_rows AS target
        SET evening_rtpl_status = src.evening_rtpl_status
        FROM jsonb_to_recordset($1::jsonb) AS src(
          row_id uuid,
          evening_rtpl_status text,
          authority_evening_updated_at timestamptz
        )
        WHERE target.id = src.row_id
          AND target.evening_rtpl_status IS DISTINCT FROM src.evening_rtpl_status
          AND (
            -- Never Evening-edited here, so nothing of the user's to protect.
            target.evening_rtpl_status_updated_at IS NULL
            -- Or this row's own Evening predates the authority's.
            OR (src.authority_evening_updated_at IS NOT NULL
                AND target.evening_rtpl_status_updated_at < src.authority_evening_updated_at)
          )
      `,
      [
        JSON.stringify(
          chunk.map((payload) => ({
            row_id: payload.rowId,
            evening_rtpl_status: payload.eveningRtplStatus,
            authority_evening_updated_at: payload.authorityEveningUpdatedAt,
          })),
        ),
      ],
    );
  });
}

/** Shared `jsonb_to_recordset` column list for the two carry-forward writers. */
const CARRY_FORWARD_SRC_COLUMNS = `
          row_id uuid,
          rtpl_status text,
          segment text,
          engineer text,
          location text,
          case_created_time timestamptz,
          status_aging text,
          hp_owner_status text,
          customer_mail text,
          rca text,
          remarks text,
          manual_notes text,
          carried_forward_fields jsonb,
          manual_fields_completed boolean,
          -- Read as jsonb and expanded below: a JSON array reaches a text[] column
          -- only through an explicit expansion.
          manual_fields_missing jsonb`;

function carryForwardSrcJson(
  payloads: readonly (
    | ReportRowCarryForwardBackfillPayload
    | ReportRowCarryForwardOverwritePayload
  )[],
): string {
  return JSON.stringify(
    payloads.map((payload) => ({
      row_id: payload.rowId,
      rtpl_status: payload.rtplStatus,
      // Absent from the overwrite payload by design: segment is recomputed from the
      // source file every run and is never carried forward.
      segment: "segment" in payload ? payload.segment : null,
      engineer: payload.engineer,
      location: payload.location,
      case_created_time: payload.caseCreatedTime,
      status_aging: payload.statusAging,
      hp_owner_status: payload.hpOwnerStatus,
      customer_mail: payload.customerMail,
      rca: payload.rca,
      remarks: payload.remarks,
      manual_notes: payload.manualNotes,
      carried_forward_fields: payload.carriedForwardFields,
      manual_fields_completed: payload.manualFieldsCompleted,
      manual_fields_missing: payload.manualFieldsMissing,
    })),
  );
}

/** `manual_fields_missing` as a text[], expanded from the JSON array it arrives as. */
const MANUAL_FIELDS_MISSING_ARRAY =
  "ARRAY(SELECT jsonb_array_elements_text(src.manual_fields_missing))::text[]";

/**
 * Fill-if-empty carry-forward repair, for many rows at once.
 *
 * Every `CASE WHEN ... IS NULL` guard is preserved verbatim from the row-at-a-time form
 * this replaced, now reading `target.<column>` instead of the bare column name. It is the write that
 * fires hardest on the day's FIRST report, when the previous day's manual work has to be
 * repaired onto every row at once — the load where one round-trip per row hurt most.
 */
export async function backfillMissingDailyCallPlanReportRowCarryForwardBulk(
  client: PoolClient,
  payloads: readonly ReportRowCarryForwardBackfillPayload[],
): Promise<void> {
  if (payloads.length === 0) return;

  await inChunks(payloads, async (chunk) => {
    await client.query(
      `
        UPDATE daily_call_plan_report_rows AS target
        SET
          rtpl_status = CASE
            WHEN src.rtpl_status IS NOT NULL AND NULLIF(TRIM(COALESCE(target.rtpl_status, '')), '') IS NULL THEN src.rtpl_status
            ELSE target.rtpl_status
          END,
          segment = CASE
            WHEN src.segment IS NOT NULL AND NULLIF(TRIM(COALESCE(target.segment, '')), '') IS NULL THEN src.segment
            ELSE target.segment
          END,
          engineer = CASE
            WHEN src.engineer IS NOT NULL AND NULLIF(TRIM(COALESCE(target.engineer, '')), '') IS NULL THEN src.engineer
            ELSE target.engineer
          END,
          location = CASE
            WHEN src.location IS NOT NULL AND NULLIF(TRIM(COALESCE(target.location, '')), '') IS NULL THEN src.location
            ELSE target.location
          END,
          case_created_time = CASE
            WHEN src.case_created_time IS NOT NULL AND target.case_created_time IS NULL THEN src.case_created_time
            ELSE target.case_created_time
          END,
          status_aging = CASE
            WHEN src.status_aging IS NOT NULL AND NULLIF(TRIM(COALESCE(target.status_aging, '')), '') IS NULL THEN src.status_aging
            ELSE target.status_aging
          END,
          hp_owner_status = CASE
            WHEN src.hp_owner_status IS NOT NULL AND NULLIF(TRIM(COALESCE(target.hp_owner_status, '')), '') IS NULL THEN src.hp_owner_status
            ELSE target.hp_owner_status
          END,
          customer_mail = CASE
            WHEN src.customer_mail IS NOT NULL AND NULLIF(TRIM(COALESCE(target.customer_mail, '')), '') IS NULL THEN src.customer_mail
            ELSE target.customer_mail
          END,
          rca = CASE
            WHEN src.rca IS NOT NULL AND NULLIF(TRIM(COALESCE(target.rca, '')), '') IS NULL THEN src.rca
            ELSE target.rca
          END,
          remarks = CASE
            WHEN src.remarks IS NOT NULL AND NULLIF(TRIM(COALESCE(target.remarks, '')), '') IS NULL THEN src.remarks
            ELSE target.remarks
          END,
          manual_notes = CASE
            WHEN src.manual_notes IS NOT NULL AND NULLIF(TRIM(COALESCE(target.manual_notes, '')), '') IS NULL THEN src.manual_notes
            ELSE target.manual_notes
          END,
          carried_forward_fields = src.carried_forward_fields,
          manual_fields_completed = src.manual_fields_completed,
          manual_fields_missing = ${MANUAL_FIELDS_MISSING_ARRAY}
        FROM jsonb_to_recordset($1::jsonb) AS src(${CARRY_FORWARD_SRC_COLUMNS}
        )
        WHERE target.id = src.row_id
      `,
      [carryForwardSrcJson(chunk)],
    );
  });
}

/**
 * Overwrite of inherited fields whose source value changed, for many rows at once.
 *
 * Unconditional per column, as it has always been: an inherited field whose source
 * moved must be replaced, not filled-if-empty, or the stale value survives into
 * the next day's carry-forward.
 */
export async function overwriteCarriedForwardFieldValuesBulk(
  client: PoolClient,
  payloads: readonly ReportRowCarryForwardOverwritePayload[],
): Promise<void> {
  if (payloads.length === 0) return;

  await inChunks(payloads, async (chunk) => {
    await client.query(
      `
        UPDATE daily_call_plan_report_rows AS target
        SET
          rtpl_status = src.rtpl_status,
          engineer = src.engineer,
          location = src.location,
          case_created_time = src.case_created_time,
          status_aging = src.status_aging,
          hp_owner_status = src.hp_owner_status,
          customer_mail = src.customer_mail,
          rca = src.rca,
          remarks = src.remarks,
          manual_notes = src.manual_notes,
          carried_forward_fields = src.carried_forward_fields,
          manual_fields_completed = src.manual_fields_completed,
          manual_fields_missing = ${MANUAL_FIELDS_MISSING_ARRAY}
        FROM jsonb_to_recordset($1::jsonb) AS src(${CARRY_FORWARD_SRC_COLUMNS}
        )
        WHERE target.id = src.row_id
      `,
      [carryForwardSrcJson(chunk)],
    );
  });
}

export async function findDailyCallPlanReportRowForEdit(
  rowId: string,
): Promise<EditedReportRow | null> {
  const result = await query<EditedReportRowDbRow>(
    `
      SELECT
        rows.id,
        rows.report_id,
        rows.serial_no,
        rows.ticket_id,
        rows.case_id,
        reports.region_id::TEXT AS region_id,
        rows.work_location,
        rows.case_created_time::TEXT AS case_created_time,
        rows.wip_aging,
        rows.status_aging,
        rows.hp_owner_status,
        rows.engineer,
        rows.rtpl_status,
        rows.evening_rtpl_status,
        rows.customer_mail,
        rows.rca,
        rows.remarks,
        rows.manual_notes,
        rows.location,
        rows.segment,
        rows.part,
        rows.customer_name,
        rows.carried_forward_fields,
        rows.manual_fields_completed,
        rows.manual_fields_missing,
        COALESCE(rows.updated_at, rows.created_at)::TEXT AS updated_at,
        rows.updated_by::TEXT AS updated_by
      FROM daily_call_plan_report_rows rows
      JOIN daily_call_plan_reports reports
        ON reports.id = rows.report_id
      WHERE rows.id = $1
      LIMIT 1
    `,
    [rowId],
  );

  const row = result.rows[0];
  return row ? mapEditedReportRow(row) : null;
}

/**
 * The three fields needed to decide whether a special-access credential is allowed to
 * touch a row: its work location (region grant) and its WO OTC code + segment (data
 * scope: overall / warranty / trade). Read-only helper — nothing else uses it.
 */
export interface ReportRowScopeFields {
  workLocation: string | null;
  woOtcCode: string | null;
  segment: string | null;
}

export async function findReportRowScopeFields(
  rowId: string,
): Promise<ReportRowScopeFields | null> {
  const result = await query<{
    work_location: string | null;
    wo_otc_code: string | null;
    segment: string | null;
  }>(
    `
      SELECT work_location, wo_otc_code, segment
      FROM daily_call_plan_report_rows
      WHERE id = $1
      LIMIT 1
    `,
    [rowId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    workLocation: row.work_location,
    woOtcCode: row.wo_otc_code,
    segment: row.segment,
  };
}

export async function deleteDailyCallPlanReportRow(
  rowId: string,
  updatedBy: string,
): Promise<boolean> {
  const result = await query(
    `
      UPDATE daily_call_plan_report_rows
      SET
        is_excluded = TRUE,
        updated_at = NOW(),
        updated_by = $2
      WHERE id = $1
        AND NOT is_excluded
    `,
    [rowId, updatedBy],
  );

  return (result.rowCount ?? 0) > 0;
}
