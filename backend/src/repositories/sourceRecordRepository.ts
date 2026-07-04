import type { PoolClient } from "pg";
import type {
  CallPlanParsedRecord,
  FlexWipParsedRecord,
  RenderwaysParsedRecord,
} from "../types/sourceRecords.js";
import { getCell } from "../services/excelParser/rowAccess.js";
import { cleanString, parseAgingDays } from "../services/normalization/valueNormalizer.js";

interface FlexWipRecordRow {
  id: string;
  ticket_id: string;
  normalized_ticket_id: string;
  case_id: string | null;
  normalized_case_id: string | null;
  create_time: Date | null;
  product: string | null;
  flex_status: string | null;
  wo_otc_code: string | null;
  account_name: string | null;
  customer_name: string | null;
  contact: string | null;
  customer_email: string | null;
  part_description: string | null;
  customer_pincode: string | null;
  product_line_name: string | null;
  work_location: string | null;
  raw_row: Record<string, unknown>;
  row_number: number;
}

interface RenderwaysRecordRow {
  id: string;
  ticket_id: string | null;
  normalized_ticket_id: string | null;
  case_id: string;
  normalized_case_id: string;
  partner_accept: Date | null;
  wip_aging: string | null;
  wip_aging_category: string | null;
  rtpl_status: string | null;
  hp_owner: string | null;
  rca_message: string | null;
  product_type: string | null;
  call_classification: string | null;
  raw_row: Record<string, unknown>;
  row_number: number;
}

interface CallPlanRecordRow {
  id: string;
  ticket_id: string;
  normalized_ticket_id: string;
  morning_status: string | null;
  engineer: string | null;
  location: string | null;
  raw_row: Record<string, unknown>;
  row_number: number;
}

export async function insertFlexWipRecords(
  client: PoolClient,
  uploadBatchId: string,
  records: readonly FlexWipParsedRecord[],
): Promise<void> {
  for (const record of records) {
    await client.query(
      `
        INSERT INTO flex_wip_records (
          upload_batch_id,
          ticket_id,
          normalized_ticket_id,
          case_id,
          normalized_case_id,
          create_time,
          product,
          flex_status,
          wo_otc_code,
          account_name,
          customer_name,
          contact,
          customer_email,
          part_description,
          customer_pincode,
          product_line_name,
          work_location,
          raw_row,
          row_number
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19
        )
      `,
      [
        uploadBatchId,
        record.ticketId,
        record.normalizedTicketId,
        record.caseId,
        record.normalizedCaseId,
        record.createTime,
        record.product,
        record.flexStatus,
        record.woOtcCode,
        record.accountName,
        record.customerName,
        record.contact,
        record.customerEmail,
        record.partDescription,
        record.customerPincode,
        record.productLineName,
        record.workLocation,
        JSON.stringify(record.rawRow),
        record.rowNumber,
      ],
    );
  }
}

export async function insertRenderwaysRecords(
  client: PoolClient,
  uploadBatchId: string,
  records: readonly RenderwaysParsedRecord[],
): Promise<void> {
  for (const record of records) {
    await client.query(
      `
        INSERT INTO renderways_records (
          upload_batch_id,
          ticket_id,
          normalized_ticket_id,
          case_id,
          normalized_case_id,
          partner_accept,
          wip_aging,
          wip_aging_category,
          rtpl_status,
          hp_owner,
          rca_message,
          product_type,
          call_classification,
          raw_row,
          row_number
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14::jsonb, $15
        )
      `,
      [
        uploadBatchId,
        record.ticketId,
        record.normalizedTicketId,
        record.caseId,
        record.normalizedCaseId,
        record.partnerAccept,
        record.wipAging,
        record.wipAgingCategory,
        record.rtplStatus,
        record.hpOwner,
        record.rcaMessage,
        record.productType,
        record.callClassification,
        JSON.stringify(record.rawRow),
        record.rowNumber,
      ],
    );
  }
}

export async function insertCallPlanRecords(
  client: PoolClient,
  uploadBatchId: string,
  records: readonly CallPlanParsedRecord[],
): Promise<void> {
  for (const record of records) {
    await client.query(
      `
        INSERT INTO call_plan_records (
          upload_batch_id,
          ticket_id,
          normalized_ticket_id,
          morning_status,
          engineer,
          location,
          raw_row,
          row_number
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
      `,
      [
        uploadBatchId,
        record.ticketId,
        record.normalizedTicketId,
        record.morningStatus,
        record.engineer,
        record.location,
        JSON.stringify(record.rawRow),
        record.rowNumber,
      ],
    );
  }
}

export async function findFlexWipRecordsByBatchId(
  client: PoolClient,
  uploadBatchId: string,
): Promise<FlexWipParsedRecord[]> {
  const result = await client.query<FlexWipRecordRow>(
    `
      SELECT
        id,
        ticket_id,
        normalized_ticket_id,
        case_id,
        normalized_case_id,
        create_time,
        product,
        flex_status,
        wo_otc_code,
        account_name,
        customer_name,
        contact,
        customer_email,
        part_description,
        customer_pincode,
        product_line_name,
        work_location,
        raw_row,
        row_number
      FROM flex_wip_records
      WHERE upload_batch_id = $1
      ORDER BY row_number ASC
    `,
    [uploadBatchId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    ticketId: row.ticket_id,
    normalizedTicketId: row.normalized_ticket_id,
    caseId: row.case_id,
    normalizedCaseId: row.normalized_case_id,
    createTime: row.create_time,
    product: row.product,
    flexStatus: row.flex_status,
    woOtcCode: row.wo_otc_code,
    accountName: row.account_name,
    customerName: row.customer_name,
    contact: row.contact,
    customerEmail: row.customer_email,
    partDescription: row.part_description,
    customerPincode: row.customer_pincode,
    productLineName: row.product_line_name,
    workLocation: row.work_location,
    productSerialNo: cleanString(getCell(row.raw_row as Record<string, unknown>, ["Product Serial No", "Product S.No", "Product SN", "Serial No", "Serial Number"])),
    businessSegment: cleanString(getCell(row.raw_row as Record<string, unknown>, ["Business Segment", "BusinessSegment", "Business segment"])),
    rawRow: row.raw_row,
    rowNumber: row.row_number,
  }));
}

export async function findRenderwaysRecordsByBatchId(
  client: PoolClient,
  uploadBatchId: string,
): Promise<RenderwaysParsedRecord[]> {
  const result = await client.query<RenderwaysRecordRow>(
    `
      SELECT
        id,
        ticket_id,
        normalized_ticket_id,
        case_id,
        normalized_case_id,
        partner_accept,
        wip_aging,
        wip_aging_category,
        rtpl_status,
        hp_owner,
        rca_message,
        product_type,
        call_classification,
        raw_row,
        row_number
      FROM renderways_records
      WHERE upload_batch_id = $1
      ORDER BY row_number ASC
    `,
    [uploadBatchId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    ticketId: row.ticket_id,
    normalizedTicketId: row.normalized_ticket_id,
    caseId: row.case_id,
    normalizedCaseId: row.normalized_case_id,
    partnerAccept: row.partner_accept,
    wipAging: row.wip_aging,
    wipAgingCategory: row.wip_aging_category,
    rtplStatus: row.rtpl_status,
    hpOwner: row.hp_owner,
    rcaMessage: row.rca_message,
    productType: row.product_type,
    callClassification: row.call_classification,
    customerType: cleanString(getCell(row.raw_row as Record<string, unknown>, ["Customer Type", "CustomerType", "Customer type"])),
    wipChangedFromMorningReport: cleanString(getCell(row.raw_row as Record<string, unknown>, ["WIP Changed From Morning Report", "WIP Changes From Morning Report", "Wip Chnages From Morning Report", "WIP Changed"])),
    currentStatusAging: parseAgingDays(getCell(row.raw_row as Record<string, unknown>, ["Current Status Aging", "current status aging", "Status Aging"])),
    rawRow: row.raw_row,
    rowNumber: row.row_number,
  }));
}

export async function findCallPlanRecordsByBatchId(
  client: PoolClient,
  uploadBatchId: string,
): Promise<CallPlanParsedRecord[]> {
  const result = await client.query<CallPlanRecordRow>(
    `
      SELECT
        id,
        ticket_id,
        normalized_ticket_id,
        morning_status,
        engineer,
        location,
        raw_row,
        row_number
      FROM call_plan_records
      WHERE upload_batch_id = $1
      ORDER BY row_number ASC
    `,
    [uploadBatchId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    ticketId: row.ticket_id,
    normalizedTicketId: row.normalized_ticket_id,
    morningStatus: row.morning_status,
    engineer: row.engineer,
    location: row.location,
    rawRow: row.raw_row,
    rowNumber: row.row_number,
  }));
}
