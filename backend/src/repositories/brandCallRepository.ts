import type { Pool, PoolClient } from "pg";
import type { CallBrand } from "@opencall/shared";
import { pool, query } from "../config/database.js";

/**
 * Calls for brands other than HP (migration 074): Acer first, pasted in by a SUPER_ADMIN.
 * The report generator adds the open ones to every daily report; see
 * services/brandCalls/brandCallReportRows.ts.
 */

export interface BrandCall {
  id: string;
  brand: CallBrand;
  caseId: string;
  ticketId: string;
  regionCode: string;
  customerName: string;
  callStatus: string;
  serviceType: string;
  model: string;
  productCategory: string;
  serialNumber: string;
  issueDescription: string;
  warrantyStatus: string;
  fullAddress: string;
  pincode: string;
  primaryContact: string;
  altContact: string;
  createdAt: string;
  createdBy: string;
  closedAt: string | null;
  closedStatus: string | null;
  closedBy: string | null;
  reopenedAt: string | null;
  deletedAt: string | null;
}

export interface NewBrandCall {
  caseId: string;
  ticketId: string;
  regionCode: string;
  customerName: string;
  callStatus: string;
  serviceType: string;
  model: string;
  productCategory: string;
  serialNumber: string;
  issueDescription: string;
  warrantyStatus: string;
  fullAddress: string;
  pincode: string;
  primaryContact: string;
  altContact: string;
  sourceLine: string;
}

interface BrandCallDbRow {
  id: string;
  brand: string;
  case_id: string;
  ticket_id: string;
  region_code: string;
  customer_name: string;
  call_status: string;
  service_type: string;
  model: string;
  product_category: string;
  serial_number: string;
  issue_description: string;
  warranty_status: string;
  full_address: string;
  pincode: string;
  primary_contact: string;
  alt_contact: string;
  created_at: string;
  created_by: string;
  closed_at: string | null;
  closed_status: string | null;
  closed_by: string | null;
  reopened_at: string | null;
  deleted_at: string | null;
}

const SELECT_COLUMNS = `
  id, brand, case_id, ticket_id, region_code, customer_name, call_status, service_type,
  model, product_category, serial_number, issue_description, warranty_status, full_address,
  pincode, primary_contact, alt_contact, to_json(created_at)#>>'{}' AS created_at, created_by,
  to_json(closed_at)#>>'{}' AS closed_at, closed_status, closed_by,
  to_json(reopened_at)#>>'{}' AS reopened_at, to_json(deleted_at)#>>'{}' AS deleted_at
`;

function mapRow(row: BrandCallDbRow): BrandCall {
  return {
    id: row.id,
    brand: row.brand as CallBrand,
    caseId: row.case_id,
    ticketId: row.ticket_id,
    regionCode: row.region_code,
    customerName: row.customer_name,
    callStatus: row.call_status,
    serviceType: row.service_type,
    model: row.model,
    productCategory: row.product_category,
    serialNumber: row.serial_number,
    issueDescription: row.issue_description,
    warrantyStatus: row.warranty_status,
    fullAddress: row.full_address,
    pincode: row.pincode,
    primaryContact: row.primary_contact,
    altContact: row.alt_contact,
    createdAt: row.created_at,
    createdBy: row.created_by,
    closedAt: row.closed_at,
    closedStatus: row.closed_status,
    closedBy: row.closed_by,
    reopenedAt: row.reopened_at,
    deletedAt: row.deleted_at,
  };
}

type Queryable = Pool | PoolClient;

/**
 * Does brand_calls exist yet? Report generation runs on every page load and reads this
 * table inside its transaction, where a missing-table error cannot be caught — it aborts
 * the transaction and takes the whole dashboard down. So readers ask first, and a deploy
 * whose migration has not run simply has no Acer calls. Cached once it is true.
 */
let tableKnownToExist = false;

export async function brandCallsTableExists(db: Queryable = pool): Promise<boolean> {
  if (tableKnownToExist) {
    return true;
  }
  const result = await db.query<{ present: boolean }>(
    `SELECT to_regclass('public.brand_calls') IS NOT NULL AS present`,
  );
  tableKnownToExist = result.rows[0]?.present === true;
  return tableKnownToExist;
}

/**
 * The calls (all brands) a report for `reportDate` (YYYY-MM-DD) lists as open, oldest
 * first — what the report generator adds:
 *
 *  - entered on or before that day (IST): reopening an old report from history must not
 *    pull in calls entered since;
 *  - still open, or closed ON that day or later. A call closed today stays on today's
 *    report — with its Case-Closed Evening — and leaves on tomorrow's first report,
 *    where the carry-forward closes it. That is how an HP call the team closes in the
 *    day behaves too: it stays in the Flex file until the next day.
 */
export async function findOpenBrandCalls(db: Queryable, reportDate: string): Promise<BrandCall[]> {
  if (!(await brandCallsTableExists(db))) {
    return [];
  }
  const result = await db.query<BrandCallDbRow>(
    `
      SELECT ${SELECT_COLUMNS}
      FROM brand_calls
      WHERE deleted_at IS NULL
        AND (created_at AT TIME ZONE 'Asia/Kolkata')::date <= $1::date
        AND (closed_at IS NULL OR (closed_at AT TIME ZONE 'Asia/Kolkata')::date >= $1::date)
      ORDER BY created_at ASC, case_id ASC
    `,
    [reportDate],
  );
  return result.rows.map(mapRow);
}

/** The calls of a brand among these case ids (any state), for duplicate checks. */
export async function findBrandCallsByCaseIds(
  brand: CallBrand,
  caseIds: readonly string[],
): Promise<BrandCall[]> {
  if (caseIds.length === 0 || !(await brandCallsTableExists())) {
    return [];
  }
  const result = await query<BrandCallDbRow>(
    `SELECT ${SELECT_COLUMNS} FROM brand_calls WHERE brand = $1 AND case_id = ANY($2::text[])`,
    [brand, [...caseIds]],
  );
  return result.rows.map(mapRow);
}

export async function findBrandCallByTicketId(ticketId: string): Promise<BrandCall | null> {
  if (!(await brandCallsTableExists())) {
    return null;
  }
  const result = await query<BrandCallDbRow>(
    `SELECT ${SELECT_COLUMNS} FROM brand_calls WHERE ticket_id = UPPER(TRIM($1))`,
    [ticketId],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Recently added calls of a brand, newest first, for the paste dialog's list. */
export async function listRecentBrandCalls(brand: CallBrand, limit: number): Promise<BrandCall[]> {
  if (!(await brandCallsTableExists())) {
    return [];
  }
  const result = await query<BrandCallDbRow>(
    `SELECT ${SELECT_COLUMNS} FROM brand_calls WHERE brand = $1 ORDER BY created_at DESC, case_id ASC LIMIT $2`,
    [brand, limit],
  );
  return result.rows.map(mapRow);
}

/**
 * Inserts the calls; a case already on file is skipped (ON CONFLICT), never overwritten.
 * Returns the calls actually inserted.
 */
export async function insertBrandCalls(
  client: PoolClient,
  brand: CallBrand,
  calls: readonly NewBrandCall[],
  actor: string,
): Promise<BrandCall[]> {
  const inserted: BrandCall[] = [];
  for (const call of calls) {
    const result = await client.query<BrandCallDbRow>(
      `
        INSERT INTO brand_calls (
          brand, case_id, ticket_id, region_code, customer_name, call_status, service_type,
          model, product_category, serial_number, issue_description, warranty_status,
          full_address, pincode, primary_contact, alt_contact, source_line, created_by, updated_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
        ON CONFLICT DO NOTHING
        RETURNING ${SELECT_COLUMNS}
      `,
      [
        brand,
        call.caseId,
        call.ticketId,
        call.regionCode,
        call.customerName,
        call.callStatus,
        call.serviceType,
        call.model,
        call.productCategory,
        call.serialNumber,
        call.issueDescription,
        call.warrantyStatus,
        call.fullAddress,
        call.pincode,
        call.primaryContact,
        call.altContact,
        call.sourceLine,
        actor,
      ],
    );
    const row = result.rows[0];
    if (row) {
      inserted.push(mapRow(row));
    }
  }
  return inserted;
}

/**
 * Opens or closes a call from its report row's status. closedStatus = null reopens it.
 * Returns true when the call's state changed.
 */
export async function setBrandCallClosure(input: {
  ticketId: string;
  closedStatus: string | null;
  actor: string;
}): Promise<boolean> {
  if (!(await brandCallsTableExists())) {
    return false;
  }
  const result =
    input.closedStatus === null
      ? await query(
          `
            UPDATE brand_calls
            SET closed_at = NULL, closed_status = NULL, closed_by = NULL,
                updated_at = NOW(), updated_by = $2
            WHERE ticket_id = UPPER(TRIM($1)) AND closed_at IS NOT NULL AND deleted_at IS NULL
          `,
          [input.ticketId, input.actor],
        )
      : await query(
          `
            UPDATE brand_calls
            SET closed_at = NOW(), closed_status = $2, closed_by = $3,
                reopened_at = NULL, reopened_by = NULL,
                updated_at = NOW(), updated_by = $3
            WHERE ticket_id = UPPER(TRIM($1)) AND closed_at IS NULL AND deleted_at IS NULL
          `,
          [input.ticketId, input.closedStatus, input.actor],
        );
  return (result.rowCount ?? 0) > 0;
}

/** Calls by ticket: the Records page's extra columns, and the Payroll dispatch's address. */
export async function findBrandCallDetailsByTicketIds(
  ticketIds: readonly string[],
  db: Queryable = pool,
): Promise<Map<string, BrandCall>> {
  const wanted = [...new Set(ticketIds.map((id) => id.trim().toUpperCase()).filter(Boolean))];
  if (wanted.length === 0 || !(await brandCallsTableExists(db))) {
    return new Map();
  }
  const result = await db.query<BrandCallDbRow>(
    `SELECT ${SELECT_COLUMNS} FROM brand_calls WHERE ticket_id = ANY($1::text[])`,
    [wanted],
  );
  return new Map(result.rows.map((row) => [row.ticket_id, mapRow(row)]));
}

/** District, area and coordinates of pincodes (pincode_geo), for the region suggestion. */
export async function findPincodeGeo(
  pincodes: readonly string[],
): Promise<Map<string, { district: string; areaName: string; latitude: number | null; longitude: number | null }>> {
  const wanted = [...new Set(pincodes.filter((pin) => /^\d{6}$/.test(pin)))];
  if (wanted.length === 0) {
    return new Map();
  }
  const present = await query<{ present: boolean }>(
    `SELECT to_regclass('public.pincode_geo') IS NOT NULL AS present`,
  );
  if (!present.rows[0]?.present) {
    return new Map();
  }
  const result = await query<{
    pincode: string;
    district: string | null;
    area_name: string | null;
    latitude: string | null;
    longitude: string | null;
  }>(
    `SELECT pincode, district, area_name, latitude::TEXT AS latitude, longitude::TEXT AS longitude
     FROM pincode_geo WHERE pincode = ANY($1::text[])`,
    [wanted],
  );
  return new Map(
    result.rows.map((row) => [
      row.pincode,
      {
        district: row.district ?? "",
        areaName: row.area_name ?? "",
        latitude: row.latitude === null ? null : Number(row.latitude),
        longitude: row.longitude === null ? null : Number(row.longitude),
      },
    ]),
  );
}

/** Each branch office's coordinates (region_offices), for the nearest-branch fallback. */
export async function findBranchOfficeCoordinates(): Promise<
  { aspCode: string; latitude: number; longitude: number }[]
> {
  const present = await query<{ present: boolean }>(
    `SELECT to_regclass('public.region_offices') IS NOT NULL AS present`,
  );
  if (!present.rows[0]?.present) {
    return [];
  }
  const result = await query<{ asp_code: string; latitude: string | null; longitude: string | null }>(
    `SELECT asp_code, latitude::TEXT AS latitude, longitude::TEXT AS longitude FROM region_offices`,
  );
  return result.rows
    .filter((row) => row.latitude !== null && row.longitude !== null)
    .map((row) => ({
      aspCode: row.asp_code.trim().toUpperCase(),
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
    }));
}

export type BrandCallListStatus = "open" | "closed" | "all";

/** A call with how its latest report row stands — the Acer tab's "All calls" list. */
export interface BrandCallListItem extends BrandCall {
  engineer: string | null;
  morningStatus: string | null;
  eveningStatus: string | null;
  remarks: string | null;
  lastReportDate: string | null;
}

/**
 * Calls of a brand for the "All calls" list, most recently opened or closed first, with
 * the engineer and statuses of each call's latest report row. Deleted calls are left out.
 * `regionCodes` (upper-case ASP codes) limits it to a REGION_ADMIN's regions; null = all.
 */
export async function listBrandCalls(input: {
  brand: CallBrand;
  status: BrandCallListStatus;
  regionCodes: readonly string[] | null;
  search: string;
  limit: number;
}): Promise<BrandCallListItem[]> {
  if (!(await brandCallsTableExists())) {
    return [];
  }
  const params: unknown[] = [input.brand, input.limit];
  const where: string[] = ["brand = $1", "deleted_at IS NULL"];
  if (input.status === "open") where.push("closed_at IS NULL");
  if (input.status === "closed") where.push("closed_at IS NOT NULL");
  if (input.regionCodes) {
    params.push([...input.regionCodes]);
    where.push(`UPPER(region_code) = ANY($${params.length}::text[])`);
  }
  const search = input.search.trim();
  if (search) {
    params.push(`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const p = `$${params.length}`;
    where.push(
      `(case_id ILIKE ${p} OR customer_name ILIKE ${p} OR serial_number ILIKE ${p} OR primary_contact ILIKE ${p} OR pincode ILIKE ${p})`,
    );
  }
  const result = await query<
    BrandCallDbRow & {
      sort_at: string;
      engineer: string | null;
      rtpl_status: string | null;
      evening_rtpl_status: string | null;
      remarks: string | null;
      last_report_date: string | null;
    }
  >(
    `
      SELECT b.*, last.engineer, last.rtpl_status, last.evening_rtpl_status, last.remarks,
             last.report_date AS last_report_date
      FROM (
        SELECT ${SELECT_COLUMNS}, COALESCE(closed_at, created_at) AS sort_at
        FROM brand_calls
        WHERE ${where.join(" AND ")}
        ORDER BY COALESCE(closed_at, created_at) DESC, case_id ASC
        LIMIT $2
      ) b
      LEFT JOIN LATERAL (
        SELECT r.engineer, r.rtpl_status, r.evening_rtpl_status, r.remarks,
               d.report_date::TEXT AS report_date
        FROM daily_call_plan_report_rows r
        JOIN daily_call_plan_reports d ON d.id = r.report_id
        WHERE UPPER(TRIM(r.ticket_id)) = b.ticket_id AND NOT r.is_excluded
        ORDER BY d.report_date DESC, r.updated_at DESC NULLS LAST
        LIMIT 1
      ) last ON TRUE
      ORDER BY b.sort_at DESC, b.case_id ASC
    `,
    params,
  );
  return result.rows.map((row) => ({
    ...mapRow(row),
    engineer: row.engineer,
    morningStatus: row.rtpl_status,
    eveningStatus: row.evening_rtpl_status,
    remarks: row.remarks,
    lastReportDate: row.last_report_date,
  }));
}

export async function findBrandCallById(id: string): Promise<BrandCall | null> {
  if (!(await brandCallsTableExists())) {
    return null;
  }
  const result = await query<BrandCallDbRow>(
    `SELECT ${SELECT_COLUMNS} FROM brand_calls WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** The fields an admin may correct after saving. Not the case id: it is the ticket. */
export type BrandCallDetails = Omit<NewBrandCall, "caseId" | "ticketId" | "sourceLine">;

/**
 * Corrects a call's details and mirrors them onto its rows in today's (and any later)
 * reports, so Records, productivity's region and the Payroll dispatch see the fix now
 * rather than at the next generation. Older reports keep what they had.
 */
export async function updateBrandCallDetails(
  client: PoolClient,
  id: string,
  details: BrandCallDetails,
  actor: string,
): Promise<BrandCall | null> {
  const result = await client.query<BrandCallDbRow>(
    `
      UPDATE brand_calls SET
        region_code = $2, customer_name = $3, call_status = $4, service_type = $5, model = $6,
        product_category = $7, serial_number = $8, issue_description = $9, warranty_status = $10,
        full_address = $11, pincode = $12, primary_contact = $13, alt_contact = $14,
        updated_at = NOW(), updated_by = $15
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING ${SELECT_COLUMNS}
    `,
    [
      id,
      details.regionCode,
      details.customerName,
      details.callStatus,
      details.serviceType,
      details.model,
      details.productCategory,
      details.serialNumber,
      details.issueDescription,
      details.warrantyStatus,
      details.fullAddress,
      details.pincode,
      details.primaryContact,
      details.altContact,
      actor,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  await client.query(
    `
      UPDATE daily_call_plan_report_rows r SET
        work_location = $2,
        customer_name = NULLIF($3, ''),
        account_name = NULLIF($3, ''),
        flex_status = NULLIF($4, ''),
        wo_otc_code = NULLIF($5, ''),
        product = NULLIF($6, ''),
        product_line_name = NULLIF($7, ''),
        product_serial_no = NULLIF($8, ''),
        contact = COALESCE(NULLIF($9, ''), NULLIF($10, ''))
      FROM daily_call_plan_reports d
      WHERE d.id = r.report_id
        AND UPPER(TRIM(r.ticket_id)) = $1
        AND d.report_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
    `,
    [
      row.ticket_id,
      details.regionCode,
      details.customerName,
      details.callStatus,
      details.serviceType,
      details.model,
      details.productCategory,
      details.serialNumber,
      details.primaryContact,
      details.altContact,
    ],
  );
  return mapRow(row);
}

/**
 * Deletes a call entered by mistake. It is no longer added to reports, and its rows in
 * every report are excluded, so it is not carried forward as a "closed" call and
 * productivity stops counting it. Pasting the same case again brings it back.
 */
export async function deleteBrandCall(
  client: PoolClient,
  id: string,
  actor: string,
): Promise<BrandCall | null> {
  const result = await client.query<BrandCallDbRow>(
    `
      UPDATE brand_calls
      SET deleted_at = NOW(), deleted_by = $2, updated_at = NOW(), updated_by = $2
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING ${SELECT_COLUMNS}
    `,
    [id, actor],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  await client.query(
    `UPDATE daily_call_plan_report_rows SET is_excluded = TRUE, updated_at = NOW()
     WHERE UPPER(TRIM(ticket_id)) = $1 AND NOT is_excluded`,
    [row.ticket_id],
  );
  return mapRow(row);
}

/**
 * Reopens a closed call. A CLOSED Morning/Evening on its rows in today's (and later)
 * reports is cleared so it shows as open work again; reopened_at tells the generator to
 * drop a "Case-Closed" the carry-forward would otherwise bring from an older report.
 */
export async function reopenBrandCall(
  client: PoolClient,
  id: string,
  actor: string,
  isClosedStatus: (status: string) => boolean,
): Promise<BrandCall | null> {
  const result = await client.query<BrandCallDbRow>(
    `
      UPDATE brand_calls SET
        closed_at = NULL, closed_status = NULL, closed_by = NULL,
        reopened_at = NOW(), reopened_by = $2, updated_at = NOW(), updated_by = $2
      WHERE id = $1 AND deleted_at IS NULL AND closed_at IS NOT NULL
      RETURNING ${SELECT_COLUMNS}
    `,
    [id, actor],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  await clearClosedStatusesFromToday(client, row.ticket_id, isClosedStatus);
  return mapRow(row);
}

async function clearClosedStatusesFromToday(
  client: PoolClient,
  ticketId: string,
  isClosedStatus: (status: string) => boolean,
): Promise<void> {
  const rows = await client.query<{
    id: string;
    rtpl_status: string | null;
    evening_rtpl_status: string | null;
  }>(
    `
      SELECT r.id, r.rtpl_status, r.evening_rtpl_status
      FROM daily_call_plan_report_rows r
      JOIN daily_call_plan_reports d ON d.id = r.report_id
      WHERE UPPER(TRIM(r.ticket_id)) = $1
        AND d.report_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
    `,
    [ticketId],
  );
  for (const reportRow of rows.rows) {
    const clearMorning = isClosedStatus(reportRow.rtpl_status ?? "");
    const clearEvening = isClosedStatus(reportRow.evening_rtpl_status ?? "");
    if (!clearMorning && !clearEvening) continue;
    await client.query(
      `
        UPDATE daily_call_plan_report_rows SET
          rtpl_status = CASE WHEN $2 THEN '' ELSE rtpl_status END,
          evening_rtpl_status = CASE WHEN $3 THEN NULL ELSE evening_rtpl_status END,
          updated_at = NOW()
        WHERE id = $1
      `,
      [reportRow.id, clearMorning, clearEvening],
    );
  }
}

/**
 * A case pasted again after it was closed or deleted (Acer re-raised it, or it was
 * deleted by mistake): its details are refreshed from the paste and it is open again.
 * An open case is left alone (returns null).
 */
export async function reviveBrandCall(
  client: PoolClient,
  brand: CallBrand,
  call: NewBrandCall,
  actor: string,
  isClosedStatus: (status: string) => boolean,
): Promise<BrandCall | null> {
  const before = await client.query<{ was_deleted: boolean }>(
    `SELECT deleted_at IS NOT NULL AS was_deleted FROM brand_calls WHERE brand = $1 AND case_id = $2`,
    [brand, call.caseId],
  );
  const wasDeleted = before.rows[0]?.was_deleted === true;
  const result = await client.query<BrandCallDbRow>(
    `
      UPDATE brand_calls SET
        region_code = $3, customer_name = $4, call_status = $5, service_type = $6, model = $7,
        product_category = $8, serial_number = $9, issue_description = $10,
        warranty_status = $11, full_address = $12, pincode = $13, primary_contact = $14,
        alt_contact = $15, source_line = $16,
        reopened_at = NOW(), reopened_by = $17,
        closed_at = NULL, closed_status = NULL, closed_by = NULL,
        deleted_at = NULL, deleted_by = NULL,
        updated_at = NOW(), updated_by = $17
      WHERE brand = $1 AND case_id = $2 AND (closed_at IS NOT NULL OR deleted_at IS NOT NULL)
      RETURNING ${SELECT_COLUMNS}
    `,
    [
      brand,
      call.caseId,
      call.regionCode,
      call.customerName,
      call.callStatus,
      call.serviceType,
      call.model,
      call.productCategory,
      call.serialNumber,
      call.issueDescription,
      call.warrantyStatus,
      call.fullAddress,
      call.pincode,
      call.primaryContact,
      call.altContact,
      call.sourceLine,
      actor,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  // Deleting excluded the call's rows in every report. Pasting it back undoes that
  // everywhere, so it returns as it was — engineer, statuses and remarks carry forward
  // from its last report instead of starting blank.
  if (wasDeleted) {
    await client.query(
      `UPDATE daily_call_plan_report_rows SET is_excluded = FALSE, updated_at = NOW()
       WHERE UPPER(TRIM(ticket_id)) = $1 AND is_excluded`,
      [row.ticket_id],
    );
  }
  await clearClosedStatusesFromToday(client, row.ticket_id, isClosedStatus);
  return mapRow(row);
}
