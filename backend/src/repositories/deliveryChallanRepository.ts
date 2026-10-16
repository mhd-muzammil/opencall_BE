import type { PoolClient } from "pg";
import { pool, query } from "../config/database.js";

/**
 * Delivery challans (Warranty Replacement) and the five branch letterheads they print.
 *
 * A challan is numbered per BRANCH and per Indian financial year, starting at 1, and keeps
 * a COPY of its branch's letterhead from the moment it was raised. Neither the number, the
 * branch, the financial year nor that copy ever changes afterwards, so the sheet the
 * customer holds always matches the record.
 */

/** The five branches, in the order every list and picker shows them. */
export const CHALLAN_BRANCH_KEYS = [
  "chennai",
  "vellore",
  "salem",
  "kanchipuram",
  "hosur",
] as const;

export type ChallanBranchKey = (typeof CHALLAN_BRANCH_KEYS)[number];

export function isChallanBranchKey(value: string): value is ChallanBranchKey {
  return (CHALLAN_BRANCH_KEYS as readonly string[]).includes(value);
}

/** What a challan prints top left. Each challan stores its own copy of this. */
export interface ChallanBranchHeader {
  branchKey: ChallanBranchKey;
  name: string;
  companyLine: string;
  /** Newline separated, printed one line each. */
  addressLines: string;
  gstin: string;
  contact: string;
  email: string;
}

export interface ChallanBranch extends ChallanBranchHeader {
  /** Null until a super admin edits the branch — a seeded row was never edited. */
  updatedAt: string | null;
  updatedBy: string;
}

/** The editable part of a branch: everything but its key. */
export type ChallanBranchDetails = Omit<ChallanBranchHeader, "branchKey">;

/** One row of the goods table. Free text, as the sheet is — the quantity prints "01". */
export interface DeliveryChallanItem {
  description: string;
  hsnSac: string;
  qty: string;
  rate: string;
  per: string;
}

export interface DeliveryChallan {
  id: string;
  branchKey: ChallanBranchKey;
  /** "2026-2027" — the Indian financial year the number belongs to. */
  finYear: string;
  /** The DC number, per branch and financial year, starting at 1. */
  dcSeq: number;
  /** YYYY-MM-DD. */
  challanDate: string;
  /** The branch's letterhead as it stood when the challan was raised. */
  branchHeader: ChallanBranchHeader;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  customerAddress: string;
  /** Newline separated, one per case. */
  caseIds: string;
  /** Newline separated, one per product. */
  productSerials: string;
  productNumbers: string;
  productNames: string;
  refNoDate: string;
  modeTerms: string;
  otherReferences: string;
  /** The goods rows, in entry order. May be empty. */
  items: DeliveryChallanItem[];
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  /** Null until someone corrects the challan — an unedited challan has no edit to report. */
  updatedAt: string | null;
}

/** Everything the form edits. The branch, financial year and number are not in it. */
export interface DeliveryChallanFields {
  challanDate: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  customerAddress: string;
  caseIds: string;
  productSerials: string;
  productNumbers: string;
  productNames: string;
  refNoDate: string;
  modeTerms: string;
  otherReferences: string;
  items: DeliveryChallanItem[];
}

export interface CreateDeliveryChallanInput extends DeliveryChallanFields {
  branchKey: ChallanBranchKey;
  createdBy: string;
}

/**
 * The same body as creating one — the edit form is the create form with the values in it.
 * `branchKey` is CHECKED against the challan's own branch, never applied.
 */
export interface UpdateDeliveryChallanInput extends DeliveryChallanFields {
  branchKey: ChallanBranchKey;
  updatedBy: string;
}

interface ChallanBranchDbRow {
  branch_key: string;
  name: string;
  company_line: string;
  address_lines: string;
  gstin: string;
  contact: string;
  email: string;
  updated_at: string | null;
  updated_by: string | null;
}

interface DeliveryChallanDbRow {
  id: string;
  branch_key: string;
  fin_year: string;
  dc_seq: number | string;
  challan_date: string;
  /** JSONB — node-postgres hands it back already parsed. */
  branch_header: unknown;
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  customer_address: string;
  case_ids: string;
  product_serials: string;
  product_numbers: string;
  product_names: string;
  ref_no_date: string;
  mode_terms: string;
  other_references: string;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
}

interface ItemDbRow {
  challan_id: string;
  description: string;
  hsn_sac: string;
  qty: string;
  rate: string;
  per: string;
}

const BRANCH_COLUMNS = `
  branch_key, name, company_line, address_lines, gstin, contact, email,
  updated_at::TEXT AS updated_at, updated_by
`;

const CHALLAN_COLUMNS = `
  id::TEXT AS id, branch_key, fin_year, dc_seq, challan_date::TEXT AS challan_date,
  branch_header, customer_name, customer_phone, customer_email, customer_address,
  case_ids, product_serials, product_numbers, product_names,
  ref_no_date, mode_terms, other_references,
  created_by, created_at::TEXT AS created_at, updated_by, updated_at::TEXT AS updated_at
`;

/**
 * Postgres "undefined_table". Every statement here touches only the delivery-challan
 * tables, so this means migration 070 has not been applied to this database yet.
 */
export function isDeliveryChallanSchemaMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "42P01"
  );
}

/**
 * The Indian financial year a challan date falls in, as the sheet prints it:
 * 2026-04-01 → "2026-2027", 2026-03-31 → "2025-2026". The year turns on April 1.
 */
export function challanFinancialYear(dateIso: string): string {
  const match = /^(\d{4})-(\d{2})-\d{2}/.exec(dateIso);
  if (!match) {
    throw new Error(`Not a YYYY-MM-DD date: ${dateIso}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const startYear = month >= 4 ? year : year - 1;
  return `${startYear}-${startYear + 1}`;
}

/**
 * "67", "DC 67", "DC No. 67" → 67: what someone types when looking for a sheet by its
 * number. Null when the search is not a number, so it is matched as text only.
 */
export function dcNumberFromSearch(search: string): number | null {
  const match = /^(?:dc\s*(?:no\.?)?\s*)?(\d{1,9})$/i.exec(search.trim());
  return match ? Number(match[1]) : null;
}

function mapBranch(row: ChallanBranchDbRow): ChallanBranch {
  return {
    branchKey: row.branch_key as ChallanBranchKey,
    name: row.name,
    companyLine: row.company_line,
    addressLines: row.address_lines,
    gstin: row.gstin,
    contact: row.contact,
    email: row.email,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? "",
  };
}

function headerOf(branch: ChallanBranch): ChallanBranchHeader {
  return {
    branchKey: branch.branchKey,
    name: branch.name,
    companyLine: branch.companyLine,
    addressLines: branch.addressLines,
    gstin: branch.gstin,
    contact: branch.contact,
    email: branch.email,
  };
}

/** The stored copy, read defensively: it is JSON, so a missing field reads as blank. */
function readHeader(value: unknown, branchKey: string): ChallanBranchHeader {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const text = (key: string): string => {
    const field = raw[key];
    return typeof field === "string" ? field : "";
  };
  return {
    branchKey: (text("branchKey") || branchKey) as ChallanBranchKey,
    name: text("name"),
    companyLine: text("companyLine"),
    addressLines: text("addressLines"),
    gstin: text("gstin"),
    contact: text("contact"),
    email: text("email"),
  };
}

function mapChallan(row: DeliveryChallanDbRow): DeliveryChallan {
  return {
    id: row.id,
    branchKey: row.branch_key as ChallanBranchKey,
    finYear: row.fin_year,
    dcSeq: Number(row.dc_seq),
    challanDate: row.challan_date,
    branchHeader: readHeader(row.branch_header, row.branch_key),
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email,
    customerAddress: row.customer_address,
    caseIds: row.case_ids,
    productSerials: row.product_serials,
    productNumbers: row.product_numbers,
    productNames: row.product_names,
    refNoDate: row.ref_no_date,
    modeTerms: row.mode_terms,
    otherReferences: row.other_references,
    // Filled by attachItems (or straight from the input on a write).
    items: [],
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by ?? "",
    updatedAt: row.updated_at,
  };
}

function copyItems(items: readonly DeliveryChallanItem[]): DeliveryChallanItem[] {
  return items.map((item) => ({
    description: item.description,
    hsnSac: item.hsnSac,
    qty: item.qty,
    rate: item.rate,
    per: item.per,
  }));
}

/** Load the goods rows for a page of challans in ONE query rather than per challan. */
async function attachItems(challans: DeliveryChallan[]): Promise<DeliveryChallan[]> {
  if (challans.length === 0) return challans;

  const result = await query<ItemDbRow>(
    `SELECT challan_id::TEXT AS challan_id, description, hsn_sac, qty, rate, per
       FROM delivery_challan_items
      WHERE challan_id = ANY($1::bigint[])
      ORDER BY challan_id, position, id`,
    [challans.map((challan) => challan.id)],
  );

  const byChallan = new Map<string, DeliveryChallanItem[]>();
  for (const row of result.rows) {
    const list = byChallan.get(row.challan_id) ?? [];
    list.push({
      description: row.description,
      hsnSac: row.hsn_sac,
      qty: row.qty,
      rate: row.rate,
      per: row.per,
    });
    byChallan.set(row.challan_id, list);
  }

  for (const challan of challans) {
    challan.items = byChallan.get(challan.id) ?? [];
  }
  return challans;
}

/** `position` is the order on screen, so the printed sheet lists the rows as entered. */
async function insertItems(
  client: PoolClient,
  challanId: string,
  items: readonly DeliveryChallanItem[],
): Promise<void> {
  for (const [index, item] of items.entries()) {
    await client.query(
      `INSERT INTO delivery_challan_items (
         challan_id, position, description, hsn_sac, qty, rate, per
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [challanId, index, item.description, item.hsnSac, item.qty, item.rate, item.per],
    );
  }
}

/** ROLLBACK that cannot mask the error that caused it (a dead connection would). */
async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    /* nothing open */
  }
}

/**
 * Raise a challan: copy the branch's letterhead, allocate the next number for the branch
 * and the financial year of its date, and write it with its goods rows — all in ONE
 * transaction, so a number is never handed out twice and never skipped.
 *
 * The number comes from a single INSERT ... ON CONFLICT DO UPDATE ... RETURNING on
 * `challan_sequences`. The first challan of a branch-year inserts 1; every later one bumps
 * the row and reads it back in the same statement. That row stays locked until COMMIT, so
 * two people saving for the same branch at once queue rather than collide, and a failed
 * save rolls its increment back.
 *
 * Returns null when the branch has no row (the seed is missing) — nothing is allocated.
 */
export async function createDeliveryChallan(
  input: CreateDeliveryChallanInput,
): Promise<DeliveryChallan | null> {
  const finYear = challanFinancialYear(input.challanDate);
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");

    // The letterhead as it stands NOW. The challan keeps this copy, so editing the branch
    // later never rewrites a sheet that has already gone out.
    const branchResult = await client.query<ChallanBranchDbRow>(
      `SELECT ${BRANCH_COLUMNS} FROM challan_branches WHERE branch_key = $1`,
      [input.branchKey],
    );
    const branchRow = branchResult.rows[0];
    if (!branchRow) {
      await rollback(client);
      return null;
    }
    const header = headerOf(mapBranch(branchRow));

    const seqResult = await client.query<{ last_seq: number }>(
      `INSERT INTO challan_sequences (branch_key, fin_year, last_seq)
       VALUES ($1, $2, 1)
       ON CONFLICT (branch_key, fin_year)
       DO UPDATE SET last_seq = challan_sequences.last_seq + 1
       RETURNING last_seq`,
      [input.branchKey, finYear],
    );
    const dcSeq = Number(seqResult.rows[0]!.last_seq);

    const result = await client.query<DeliveryChallanDbRow>(
      `INSERT INTO delivery_challans (
         branch_key, fin_year, dc_seq, challan_date, branch_header,
         customer_name, customer_phone, customer_email, customer_address,
         case_ids, product_serials, product_numbers, product_names,
         ref_no_date, mode_terms, other_references, created_by
       ) VALUES (
         $1, $2, $3, $4::date, $5::jsonb,
         $6, $7, $8, $9,
         $10, $11, $12, $13,
         $14, $15, $16, $17
       )
       RETURNING ${CHALLAN_COLUMNS}`,
      [
        input.branchKey,
        finYear,
        dcSeq,
        input.challanDate,
        JSON.stringify(header),
        input.customerName,
        input.customerPhone,
        input.customerEmail,
        input.customerAddress,
        input.caseIds,
        input.productSerials,
        input.productNumbers,
        input.productNames,
        input.refNoDate,
        input.modeTerms,
        input.otherReferences,
        input.createdBy,
      ],
    );

    const row = result.rows[0]!;
    await insertItems(client, row.id, input.items);

    await client.query("COMMIT");
    // Straight from the input: the rows were just written in this transaction.
    return { ...mapChallan(row), items: copyItems(input.items) };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export type UpdateDeliveryChallanResult =
  | { status: "updated"; challan: DeliveryChallan }
  | { status: "not_found" }
  /** The body named another branch. The challan is untouched. */
  | { status: "branch_locked"; branchKey: ChallanBranchKey; finYear: string; dcSeq: number }
  /** The new date falls in another financial year. The challan is untouched. */
  | { status: "fin_year_locked"; branchKey: ChallanBranchKey; finYear: string; dcSeq: number };

/**
 * Correct an existing challan in place.
 *
 * THE NUMBER DOES NOT MOVE, and neither do the branch, the financial year or the copied
 * letterhead: the customer already has the sheet under that number. So a body naming
 * another branch, or a date in another financial year, is refused rather than applied —
 * applying either would leave the number belonging to a series it was never issued from.
 * `challan_sequences` is never touched here.
 *
 * Goods rows are replaced wholesale (delete then insert, inside the transaction): the form
 * hands back the list it has, and rows can be added, removed and reordered in one edit.
 */
export async function updateDeliveryChallan(
  id: string,
  input: UpdateDeliveryChallanInput,
): Promise<UpdateDeliveryChallanResult> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");

    // Locked for the length of the edit, so the checks and the write see the same row.
    const currentResult = await client.query<{
      branch_key: string;
      fin_year: string;
      dc_seq: number | string;
    }>(
      `SELECT branch_key, fin_year, dc_seq FROM delivery_challans WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const current = currentResult.rows[0];
    if (!current) {
      await rollback(client);
      return { status: "not_found" };
    }

    const locked = {
      branchKey: current.branch_key as ChallanBranchKey,
      finYear: current.fin_year,
      dcSeq: Number(current.dc_seq),
    };
    if (input.branchKey !== current.branch_key) {
      await rollback(client);
      return { status: "branch_locked", ...locked };
    }
    if (challanFinancialYear(input.challanDate) !== current.fin_year) {
      await rollback(client);
      return { status: "fin_year_locked", ...locked };
    }

    const result = await client.query<DeliveryChallanDbRow>(
      `UPDATE delivery_challans SET
         challan_date = $2::date,
         customer_name = $3,
         customer_phone = $4,
         customer_email = $5,
         customer_address = $6,
         case_ids = $7,
         product_serials = $8,
         product_numbers = $9,
         product_names = $10,
         ref_no_date = $11,
         mode_terms = $12,
         other_references = $13,
         updated_by = $14,
         updated_at = NOW()
       WHERE id = $1
       RETURNING ${CHALLAN_COLUMNS}`,
      [
        id,
        input.challanDate,
        input.customerName,
        input.customerPhone,
        input.customerEmail,
        input.customerAddress,
        input.caseIds,
        input.productSerials,
        input.productNumbers,
        input.productNames,
        input.refNoDate,
        input.modeTerms,
        input.otherReferences,
        input.updatedBy,
      ],
    );

    await client.query(`DELETE FROM delivery_challan_items WHERE challan_id = $1`, [id]);
    await insertItems(client, id, input.items);

    await client.query("COMMIT");
    return {
      status: "updated",
      challan: { ...mapChallan(result.rows[0]!), items: copyItems(input.items) },
    };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export interface ListDeliveryChallansResult {
  items: DeliveryChallan[];
  total: number;
  page: number;
  perPage: number;
  pages: number;
}

/**
 * Newest first. `search` matches the DC number (exactly — "67" finds DC No. 67, not 167),
 * the customer name and the case ids; `branchKey` narrows to one branch.
 */
export async function listDeliveryChallans(input: {
  search?: string;
  branchKey?: ChallanBranchKey | null;
  page: number;
  perPage: number;
}): Promise<ListDeliveryChallansResult> {
  const page = Math.max(1, Math.floor(input.page));
  const perPage = Math.min(100, Math.max(1, Math.floor(input.perPage)));
  const offset = (page - 1) * perPage;

  const conditions: string[] = [];
  const params: unknown[] = [];

  const search = (input.search ?? "").trim();
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const like = params.length;
    const matches = [`lower(customer_name) LIKE $${like}`, `lower(case_ids) LIKE $${like}`];
    const dcNumber = dcNumberFromSearch(search);
    if (dcNumber !== null) {
      params.push(dcNumber);
      matches.unshift(`dc_seq = $${params.length}`);
    }
    conditions.push(`(${matches.join(" OR ")})`);
  }

  if (input.branchKey) {
    params.push(input.branchKey);
    conditions.push(`branch_key = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM delivery_challans ${where}`,
    params,
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  // Newest first by id, not created_at: NOW() is when a transaction began, so of two
  // saves for one branch at once the one that waited for the number (and got the
  // higher one) can carry the earlier created_at. The id is drawn after the number.
  // Qualified: a bare "id" would sort by the `id::TEXT AS id` output column, where
  // "9" comes after "18".
  const rowsResult = await query<DeliveryChallanDbRow>(
    `SELECT ${CHALLAN_COLUMNS} FROM delivery_challans ${where}
     ORDER BY delivery_challans.id DESC
     LIMIT ${perPage} OFFSET ${offset}`,
    params,
  );

  return {
    items: await attachItems(rowsResult.rows.map(mapChallan)),
    total,
    page,
    perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
  };
}

export async function findDeliveryChallanById(id: string): Promise<DeliveryChallan | null> {
  const result = await query<DeliveryChallanDbRow>(
    `SELECT ${CHALLAN_COLUMNS} FROM delivery_challans WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const [challan] = await attachItems([mapChallan(row)]);
  return challan ?? null;
}

/** The branches in display order (chennai, vellore, salem, kanchipuram, hosur). */
export async function listChallanBranches(): Promise<ChallanBranch[]> {
  const result = await query<ChallanBranchDbRow>(
    `SELECT ${BRANCH_COLUMNS} FROM challan_branches`,
  );
  const order = (key: string): number => (CHALLAN_BRANCH_KEYS as readonly string[]).indexOf(key);
  return result.rows
    .filter((row) => isChallanBranchKey(row.branch_key))
    .sort((a, b) => order(a.branch_key) - order(b.branch_key))
    .map(mapBranch);
}

/**
 * Save a branch's letterhead. Touches `challan_branches` and nothing else: every challan
 * already raised carries its own copy, so this changes only the challans raised after it.
 *
 * An upsert, so a branch whose seeded row has gone missing is put back by saving it.
 */
export async function saveChallanBranch(
  branchKey: ChallanBranchKey,
  details: ChallanBranchDetails,
  updatedBy: string,
): Promise<ChallanBranch> {
  const result = await query<ChallanBranchDbRow>(
    `INSERT INTO challan_branches (
       branch_key, name, company_line, address_lines, gstin, contact, email,
       updated_at, updated_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
     ON CONFLICT (branch_key) DO UPDATE SET
       name = EXCLUDED.name,
       company_line = EXCLUDED.company_line,
       address_lines = EXCLUDED.address_lines,
       gstin = EXCLUDED.gstin,
       contact = EXCLUDED.contact,
       email = EXCLUDED.email,
       updated_at = NOW(),
       updated_by = EXCLUDED.updated_by
     RETURNING ${BRANCH_COLUMNS}`,
    [
      branchKey,
      details.name,
      details.companyLine,
      details.addressLines,
      details.gstin,
      details.contact,
      details.email,
      updatedBy,
    ],
  );
  return mapBranch(result.rows[0]!);
}
