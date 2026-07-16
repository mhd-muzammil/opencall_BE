import type { PoolClient } from "pg";
import { pool, query } from "../config/database.js";

/**
 * OpenCall-owned HP Stock RMA parts catalog. Populated by an Excel import (which replaces
 * the whole catalog) and read/searched from the Parts Catalog section.
 */

export interface CatalogPart {
  id: string;
  partNumber: string;
  description: string;
  category: string;
  price: number;
  hsnCode: string;
  igst: string;
  cgst: string;
  sgst: string;
  eoslFlag: string;
  validity: string | null;
  partsStatus: string;
}

export interface CatalogPartInput {
  partNumber: string;
  description: string;
  category: string;
  price: number;
  hsnCode: string;
  igst: string;
  cgst: string;
  sgst: string;
  eoslFlag: string;
  /** YYYY-MM-DD or null. */
  validity: string | null;
  partsStatus: string;
}

interface CatalogPartDbRow {
  id: string;
  part_number: string;
  description: string;
  category: string;
  price: string;
  hsn_code: string;
  igst: string;
  cgst: string;
  sgst: string;
  eosl_flag: string;
  validity: string | null;
  parts_status: string;
}

function mapPart(row: CatalogPartDbRow): CatalogPart {
  return {
    id: row.id,
    partNumber: row.part_number,
    description: row.description,
    category: row.category,
    price: Number(row.price),
    hsnCode: row.hsn_code,
    igst: row.igst,
    cgst: row.cgst,
    sgst: row.sgst,
    eoslFlag: row.eosl_flag,
    validity: row.validity,
    partsStatus: row.parts_status,
  };
}

export interface ListCatalogPartsResult {
  items: CatalogPart[];
  total: number;
  page: number;
  perPage: number;
  pages: number;
}

export async function listCatalogParts(input: {
  search?: string;
  page: number;
  perPage: number;
}): Promise<ListCatalogPartsResult> {
  const page = Math.max(1, input.page);
  const perPage = Math.min(200, Math.max(1, input.perPage));
  const offset = (page - 1) * perPage;

  const conditions: string[] = [];
  const params: unknown[] = [];
  const search = (input.search ?? "").trim();
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const i = params.length;
    conditions.push(
      `(lower(part_number) LIKE $${i} OR lower(description) LIKE $${i} OR lower(hsn_code) LIKE $${i} OR lower(category) LIKE $${i})`,
    );
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM parts_catalog ${where}`,
    params,
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  const rowsResult = await query<CatalogPartDbRow>(
    `SELECT id, part_number, description, category, price::TEXT AS price,
            hsn_code, igst, cgst, sgst, eosl_flag,
            validity::TEXT AS validity, parts_status
     FROM parts_catalog
     ${where}
     ORDER BY part_number ASC
     LIMIT ${perPage} OFFSET ${offset}`,
    params,
  );

  return {
    items: rowsResult.rows.map(mapPart),
    total,
    page,
    perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
  };
}

/** Replaces the whole catalog with `parts` in one transaction. Returns inserted count. */
export async function replaceCatalogParts(
  parts: readonly CatalogPartInput[],
): Promise<number> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM parts_catalog");

    for (const p of parts) {
      await client.query(
        `INSERT INTO parts_catalog
           (part_number, description, category, price, hsn_code, igst, cgst, sgst,
            eosl_flag, validity, parts_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11)`,
        [
          p.partNumber,
          p.description,
          p.category,
          p.price,
          p.hsnCode,
          p.igst,
          p.cgst,
          p.sgst,
          p.eoslFlag,
          p.validity,
          p.partsStatus,
        ],
      );
    }

    await client.query("COMMIT");
    return parts.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteAllCatalogParts(): Promise<number> {
  const result = await query(`DELETE FROM parts_catalog`);
  return result.rowCount ?? 0;
}

export async function countCatalogParts(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM parts_catalog`,
  );
  return Number(result.rows[0]?.count ?? 0);
}
