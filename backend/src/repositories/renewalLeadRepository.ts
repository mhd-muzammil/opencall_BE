import { query } from "../config/database.js";

/**
 * Reads for the AMC / Warranty Renewal Pipeline.
 *
 * Strictly additive and almost entirely READ-ONLY: the candidate leads come from the
 * EXISTING permanent `hp_warranty_cache` (only serials HP has already been asked about —
 * this feature never enqueues a new lookup, so it adds ZERO load to the Playwright warranty
 * worker and never competes for its ~100/day budget) and are joined to the most recent
 * report row carrying the same serial. The only write is the per-serial follow-up state in
 * the new `renewal_leads` table.
 */

/**
 * Both the warranty tables (applied by a script, not a numbered migration) and the new
 * renewal table must exist before the pipeline can be read — guard so an un-migrated
 * deploy renders a setup hint rather than throwing.
 */
export async function renewalTablesPresent(): Promise<boolean> {
  const result = await query<{ present: boolean }>(
    `SELECT (
        to_regclass('public.hp_warranty_cache') IS NOT NULL
        AND to_regclass('public.renewal_leads') IS NOT NULL
      ) AS present`,
  );
  return result.rows[0]?.present ?? false;
}

export interface ExpiringWarrantyRow {
  serial: string;
  startDate: string | null;
  endDate: string;
  productNumber: string | null;
  hpStatus: string | null;
}

/**
 * Serials whose HP warranty ends inside the window: from `expiredLookbackDays` before
 * `todayIso` up to `aheadDays` after it. Only `OK` cache rows with a real end date can be
 * renewal leads — `NOT_FOUND` means HP has no entitlement to renew.
 */
export async function findExpiringWarranties(params: {
  todayIso: string;
  aheadDays: number;
  expiredLookbackDays: number;
}): Promise<ExpiringWarrantyRow[]> {
  const result = await query<{
    serial: string;
    start_date: string | null;
    end_date: string;
    product_number: string | null;
    hp_status: string | null;
  }>(
    `
      SELECT
        serial,
        start_date::TEXT AS start_date,
        end_date::TEXT   AS end_date,
        product_number,
        hp_status
      FROM hp_warranty_cache
      WHERE lookup_status = 'OK'
        AND end_date IS NOT NULL
        AND end_date >= ($1::DATE - $2::INT)
        AND end_date <= ($1::DATE + $3::INT)
      ORDER BY end_date ASC
    `,
    [params.todayIso, params.expiredLookbackDays, params.aheadDays],
  );

  return result.rows.map((row) => ({
    serial: row.serial,
    startDate: row.start_date,
    endDate: row.end_date,
    productNumber: row.product_number,
    hpStatus: row.hp_status,
  }));
}

export interface SerialCustomerRow {
  serial: string;
  ticketId: string;
  customerName: string;
  accountName: string;
  contact: string;
  customerMail: string;
  product: string;
  workLocation: string;
  reportDate: string | null;
}

/**
 * For each given (normalised) serial, the MOST RECENT report row that carried it — the
 * best-known customer, contact and work location for that machine. Read-only; excluded
 * (soft-deleted) rows are ignored, consistent with every other report-row read.
 *
 * Uses `daily_call_plan_report_rows_serial_upper_idx` (added by migration 039) so this
 * stays an index scan as the report-row history grows.
 */
export async function findLatestRowsForSerials(
  serials: readonly string[],
): Promise<SerialCustomerRow[]> {
  if (serials.length === 0) {
    return [];
  }

  const result = await query<{
    serial: string;
    ticket_id: string | null;
    customer_name: string | null;
    account_name: string | null;
    contact: string | null;
    customer_mail: string | null;
    product: string | null;
    work_location: string | null;
    report_date: string | null;
  }>(
    `
      SELECT DISTINCT ON (UPPER(TRIM(rows.product_serial_no)))
        UPPER(TRIM(rows.product_serial_no)) AS serial,
        rows.ticket_id,
        rows.customer_name,
        rows.account_name,
        rows.contact,
        rows.customer_mail,
        rows.product,
        rows.work_location,
        reports.report_date::TEXT AS report_date
      FROM daily_call_plan_report_rows rows
      JOIN daily_call_plan_reports reports
        ON reports.id = rows.report_id
      WHERE rows.product_serial_no IS NOT NULL
        AND TRIM(rows.product_serial_no) <> ''
        AND UPPER(TRIM(rows.product_serial_no)) = ANY($1::TEXT[])
        AND NOT rows.is_excluded
      ORDER BY
        UPPER(TRIM(rows.product_serial_no)),
        reports.report_date DESC,
        rows.id DESC
    `,
    [[...serials]],
  );

  return result.rows.map((row) => ({
    serial: row.serial,
    ticketId: (row.ticket_id ?? "").trim(),
    customerName: (row.customer_name ?? "").trim(),
    accountName: (row.account_name ?? "").trim(),
    contact: (row.contact ?? "").trim(),
    customerMail: (row.customer_mail ?? "").trim(),
    product: (row.product ?? "").trim(),
    workLocation: (row.work_location ?? "").trim(),
    reportDate: row.report_date,
  }));
}

export interface RenewalLeadStateRow {
  serial: string;
  status: string;
  owner: string;
  remarks: string;
  updatedAt: string;
}

/** The saved follow-up state for the given serials. Serials with no row are simply absent. */
export async function findLeadStates(
  serials: readonly string[],
): Promise<RenewalLeadStateRow[]> {
  if (serials.length === 0) {
    return [];
  }

  const result = await query<{
    serial: string;
    status: string;
    owner: string;
    remarks: string;
    updated_at: string;
  }>(
    `
      SELECT serial, status, owner, remarks, updated_at::TEXT AS updated_at
      FROM renewal_leads
      WHERE serial = ANY($1::TEXT[])
    `,
    [[...serials]],
  );

  return result.rows.map((row) => ({
    serial: row.serial,
    status: row.status,
    owner: row.owner,
    remarks: row.remarks,
    updatedAt: row.updated_at,
  }));
}

export interface UpsertRenewalLeadInput {
  serial: string;
  status: string;
  owner: string;
  remarks: string;
  updatedBy: string | null;
}

/** Save (insert or replace) the follow-up state for one serial. */
export async function upsertLeadState(
  input: UpsertRenewalLeadInput,
): Promise<RenewalLeadStateRow> {
  const result = await query<{
    serial: string;
    status: string;
    owner: string;
    remarks: string;
    updated_at: string;
  }>(
    `
      INSERT INTO renewal_leads (serial, status, owner, remarks, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (serial) DO UPDATE
      SET
        status = EXCLUDED.status,
        owner = EXCLUDED.owner,
        remarks = EXCLUDED.remarks,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
      RETURNING serial, status, owner, remarks, updated_at::TEXT AS updated_at
    `,
    [input.serial, input.status, input.owner, input.remarks, input.updatedBy],
  );

  const row = result.rows[0]!;
  return {
    serial: row.serial,
    status: row.status,
    owner: row.owner,
    remarks: row.remarks,
    updatedAt: row.updated_at,
  };
}

/** True when the serial is one HP has already resolved with a real end date. */
export async function serialHasWarrantyEntitlement(
  serial: string,
): Promise<boolean> {
  const result = await query<{ present: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1 FROM hp_warranty_cache
        WHERE serial = $1 AND lookup_status = 'OK' AND end_date IS NOT NULL
      ) AS present
    `,
    [serial],
  );
  return result.rows[0]?.present ?? false;
}

/** The work location of the most recent report row carrying this serial ("" when unknown). */
export async function findWorkLocationForSerial(serial: string): Promise<string> {
  const rows = await findLatestRowsForSerials([serial]);
  return rows[0]?.workLocation ?? "";
}
