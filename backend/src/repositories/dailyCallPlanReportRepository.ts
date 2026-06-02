import type { PoolClient } from "pg";
import { query } from "../config/database.js";
import type {
  GeneratedDailyCallPlanRow,
  GenerateDailyCallPlanInput,
  ManualCarryForwardField,
} from "../types/reportGeneration.js";

interface DailyReportRow {
  id: string;
}

interface InsertedDailyReportRow {
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
  updated_by: string | null;
  is_excluded: boolean;
}

export interface ReportRowEditPayload {
  engineer?: string | null;
  rtplStatus?: string | null;
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
  clearedCarryForwardFields?: readonly ManualCarryForwardField[];
  manualFieldsCompleted: boolean;
  manualFieldsMissing: readonly ManualCarryForwardField[];
  updatedBy: string | null;
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
  customerMail: string | null;
  rca: string | null;
  remarks: string | null;
  manualNotes: string | null;
  location: string | null;
  segment: string | null;
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
  customer_mail: string | null;
  rca: string | null;
  remarks: string | null;
  manual_notes: string | null;
  location: string | null;
  segment: string | null;
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
  rtplStatus: string | null;
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
  location: string | null;
  contact: string | null;
  part: string | null;
  wipAgingCategory: string | null;
  tat: string | null;
  customerMail: string | null;
  rca: string | null;
  remarks: string | null;
  manualNotes: string | null;
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
  location: string | null;
  contact: string | null;
  part: string | null;
  wip_aging_category: string | null;
  tat: string | null;
  customer_mail: string | null;
  rca: string | null;
  remarks: string | null;
  manual_notes: string | null;
}

function mapFinalReportManualCarryForwardRow(
  row: FinalReportManualCarryForwardDbRow,
): FinalReportManualCarryForwardRow {
  return {
    serialNo: row.serial_no,
    ticketId: row.ticket_id,
    caseId: row.case_id,
    caseCreatedTime: row.case_created_time,
    wipAging: row.wip_aging,
    rtplStatus: row.rtpl_status,
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
    location: row.location,
    contact: row.contact,
    part: row.part,
    wipAgingCategory: row.wip_aging_category,
    tat: row.tat,
    customerMail: row.customer_mail,
    rca: row.rca,
    remarks: row.remarks,
    manualNotes: row.manual_notes,
    manualValues: {
      rtpl_status: row.rtpl_status,
      segment: row.segment,
      engineer: row.engineer,
      location: row.location,
      status_aging: row.status_aging,
      customer_mail: row.customer_mail,
      rca: row.rca,
      remarks: row.remarks,
      manual_notes: row.manual_notes,
    },
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
    customerMail: row.customer_mail,
    rca: row.rca,
    remarks: row.remarks,
    manualNotes: row.manual_notes,
    location: row.location,
    segment: row.segment,
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

export async function insertDailyCallPlanReportRows(
  client: PoolClient,
  reportId: string,
  rows: readonly GeneratedDailyCallPlanRow[],
): Promise<void> {
  for (const row of rows) {
    const result = await client.query<InsertedDailyReportRow>(
      `
        INSERT INTO daily_call_plan_report_rows (
          report_id,
          serial_no,
          ticket_id,
          case_id,
          case_created_time,
          wip_aging,
          status_aging,
          rtpl_status,
          segment,
          engineer,
          product,
          product_line_name,
          work_location,
          flex_status,
          hp_owner_status,
          wo_otc_code,
          account_name,
          customer_name,
          location,
          contact,
          part,
          wip_aging_category,
          tat,
          customer_mail,
          rca,
          remarks,
          manual_notes,
          change_type,
          previous_flex_status,
          previous_rtpl_status,
          previous_wip_aging,
          changed_fields,
          change_summary,
          carried_forward_fields,
          manual_fields_completed,
          manual_fields_missing,
          match_status,
          match_notes
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22, $23, $24,
          $25, $26, $27, $28, $29, $30, $31, $32::jsonb, $33, $34::jsonb, $35, $36::text[],
          $37, $38::jsonb
        )
        RETURNING id, updated_at::TEXT AS updated_at, updated_by::TEXT AS updated_by
      `,
      [
        reportId,
        row.serialNo,
        row.enriched.ticket_id,
        row.enriched.case_id || null,
        row.enriched.case_created_time,
        row.enriched.wip_aging,
        row.enriched.status_aging,
        row.enriched.rtpl_status,
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
      ],
    );
    const inserted = result.rows[0] as InsertedDailyReportRow | undefined;
    if (!inserted) {
      throw new Error("Daily call plan report row insert did not return a row");
    }

    row.id = inserted.id;
    row.updatedAt = inserted.updated_at;
    row.updatedBy = inserted.updated_by;
  }
}

export async function findFinalReportRowsForManualCarryForwardBySessionId(
  client: PoolClient,
  sessionId: string,
): Promise<FinalReportManualCarryForwardRow[]> {
  const result = await client.query<FinalReportManualCarryForwardDbRow>(
    `
      SELECT
        rows.serial_no,
        rows.ticket_id,
        rows.case_id,
        rows.case_created_time::TEXT AS case_created_time,
        rows.wip_aging,
        rows.rtpl_status,
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
        rows.location,
        rows.contact,
        rows.part,
        rows.wip_aging_category,
        rows.tat::TEXT AS tat,
        rows.customer_mail,
        rows.rca,
        rows.remarks,
        rows.manual_notes
      FROM report_history_sessions sessions
      JOIN daily_call_plan_report_rows rows
        ON rows.report_id = sessions.daily_call_plan_report_id
      WHERE sessions.id = $1
        AND sessions.status = 'COMPLETED'
        AND sessions.daily_call_plan_report_id IS NOT NULL
        AND NOT rows.is_excluded
      ORDER BY rows.serial_no ASC, rows.id ASC
    `,
    [sessionId],
  );

  return result.rows.map(mapFinalReportManualCarryForwardRow);
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

export async function findPreviousFinalReportRowsForManualCarryForward(
  client: PoolClient,
  input: {
    reportDate: string;
    regionId: string | null;
  },
): Promise<FinalReportManualCarryForwardRow[]> {
  const result = await client.query<FinalReportManualCarryForwardDbRow>(
    `
      WITH completed_sessions AS (
        SELECT
          sessions.id,
          sessions.updated_at,
          COALESCE(
            CASE
              WHEN title_date.parts IS NULL THEN NULL
              ELSE make_date(
                (title_date.parts)[3]::INT,
                (title_date.parts)[2]::INT,
                (title_date.parts)[1]::INT
              )
            END,
            reports.report_date
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
      previous_session AS (
        SELECT id
        FROM completed_sessions
        WHERE effective_report_date < $1::date
        ORDER BY effective_report_date DESC, updated_at DESC, id ASC
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
        rows.location,
        rows.contact,
        rows.part,
        rows.wip_aging_category,
        rows.tat::TEXT AS tat,
        rows.customer_mail,
        rows.rca,
        rows.remarks,
        rows.manual_notes
      FROM previous_session
      JOIN report_history_sessions sessions
        ON sessions.id = previous_session.id
      JOIN daily_call_plan_report_rows rows
        ON rows.report_id = sessions.daily_call_plan_report_id
      WHERE NOT rows.is_excluded
      ORDER BY rows.serial_no ASC, rows.id ASC
    `,
    [input.reportDate, input.regionId],
  );

  return result.rows.map(mapFinalReportManualCarryForwardRow);
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
        rtpl_status = $3,
        customer_mail = $4,
        rca = $5,
        remarks = $6,
        manual_notes = $7,
        location = $8,
        segment = $9,
        case_created_time = $10,
        wip_aging = $11,
        status_aging = $12,
        hp_owner_status = $13,
        carried_forward_fields = COALESCE(
          (
            SELECT jsonb_agg(field)
            FROM jsonb_array_elements_text(rows.carried_forward_fields) AS field
            WHERE NOT (field = ANY($14::text[]))
          ),
          '[]'::jsonb
        ),
        manual_fields_completed = $15,
        manual_fields_missing = $16::text[],
        updated_at = NOW(),
        updated_by = $17
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
        rows.customer_mail,
        rows.rca,
        rows.remarks,
        rows.manual_notes,
        rows.location,
        rows.segment,
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
      edit.clearedCarryForwardFields ?? [],
      edit.manualFieldsCompleted,
      edit.manualFieldsMissing,
      edit.updatedBy,
    ],
  );

  const row = result.rows[0];
  return row ? mapEditedReportRow(row) : null;
}

export async function backfillMissingDailyCallPlanReportRowCarryForward(
  client: PoolClient,
  payload: ReportRowCarryForwardBackfillPayload,
): Promise<void> {
  await client.query(
    `
      UPDATE daily_call_plan_report_rows
      SET
        rtpl_status = CASE
          WHEN $2::text IS NOT NULL AND NULLIF(TRIM(COALESCE(rtpl_status, '')), '') IS NULL THEN $2
          ELSE rtpl_status
        END,
        segment = CASE
          WHEN $3::text IS NOT NULL AND NULLIF(TRIM(COALESCE(segment, '')), '') IS NULL THEN $3
          ELSE segment
        END,
        engineer = CASE
          WHEN $4::text IS NOT NULL AND NULLIF(TRIM(COALESCE(engineer, '')), '') IS NULL THEN $4
          ELSE engineer
        END,
        location = CASE
          WHEN $5::text IS NOT NULL AND NULLIF(TRIM(COALESCE(location, '')), '') IS NULL THEN $5
          ELSE location
        END,
        case_created_time = CASE
          WHEN $6::timestamptz IS NOT NULL AND case_created_time IS NULL THEN $6::timestamptz
          ELSE case_created_time
        END,
        status_aging = CASE
          WHEN $7::text IS NOT NULL AND NULLIF(TRIM(COALESCE(status_aging, '')), '') IS NULL THEN $7
          ELSE status_aging
        END,
        hp_owner_status = CASE
          WHEN $8::text IS NOT NULL AND NULLIF(TRIM(COALESCE(hp_owner_status, '')), '') IS NULL THEN $8
          ELSE hp_owner_status
        END,
        customer_mail = CASE
          WHEN $9::text IS NOT NULL AND NULLIF(TRIM(COALESCE(customer_mail, '')), '') IS NULL THEN $9
          ELSE customer_mail
        END,
        rca = CASE
          WHEN $10::text IS NOT NULL AND NULLIF(TRIM(COALESCE(rca, '')), '') IS NULL THEN $10
          ELSE rca
        END,
        remarks = CASE
          WHEN $11::text IS NOT NULL AND NULLIF(TRIM(COALESCE(remarks, '')), '') IS NULL THEN $11
          ELSE remarks
        END,
        manual_notes = CASE
          WHEN $12::text IS NOT NULL AND NULLIF(TRIM(COALESCE(manual_notes, '')), '') IS NULL THEN $12
          ELSE manual_notes
        END,
        carried_forward_fields = $13::jsonb,
        manual_fields_completed = $14,
        manual_fields_missing = $15::text[]
      WHERE id = $1
    `,
    [
      payload.rowId,
      payload.rtplStatus,
      payload.segment,
      payload.engineer,
      payload.location,
      payload.caseCreatedTime,
      payload.statusAging,
      payload.hpOwnerStatus,
      payload.customerMail,
      payload.rca,
      payload.remarks,
      payload.manualNotes,
      JSON.stringify(payload.carriedForwardFields),
      payload.manualFieldsCompleted,
      payload.manualFieldsMissing,
    ],
  );
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
        rows.customer_mail,
        rows.rca,
        rows.remarks,
        rows.manual_notes,
        rows.location,
        rows.segment,
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
