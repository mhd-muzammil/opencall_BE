import { query } from "../config/database.js";

/**
 * Permanent, cross-job cache of HP warranty lookups. A serial is fetched from HP
 * once, ever: every subsequent job that contains it resolves from this table.
 *
 * Only terminal results worth keeping are stored — `OK` and `NOT_FOUND`. `FAILED`
 * is never cached (it must stay retryable) and `NO_SERIAL` never reaches HP.
 */
export type CachedWarrantyStatus = "OK" | "NOT_FOUND";

export interface WarrantyCacheRow {
  serial: string;
  lookup_status: CachedWarrantyStatus;
  end_date: string | null;
  product_number: string | null;
  hp_status: string | null;
  fetched_at: string;
}

export interface WarrantyCacheEntry {
  serial: string;
  lookupStatus: CachedWarrantyStatus;
  /** ISO `YYYY-MM-DD`, or null when HP reported no entitlement. */
  endDate: string | null;
  productNumber: string | null;
  /** HP's raw "Status" text (e.g. `Active`, `Expired`). */
  hpStatus: string | null;
  fetchedAt: string;
}

const WARRANTY_CACHE_COLUMNS = `
  serial,
  lookup_status,
  end_date::TEXT AS end_date,
  product_number,
  hp_status,
  fetched_at::TEXT AS fetched_at
`;

function mapWarrantyCacheEntry(row: WarrantyCacheRow): WarrantyCacheEntry {
  return {
    serial: row.serial,
    lookupStatus: row.lookup_status,
    endDate: row.end_date,
    productNumber: row.product_number,
    hpStatus: row.hp_status,
    fetchedAt: row.fetched_at,
  };
}

export async function findCachedWarranty(
  serial: string,
): Promise<WarrantyCacheEntry | null> {
  const result = await query<WarrantyCacheRow>(
    `
      SELECT ${WARRANTY_CACHE_COLUMNS}
      FROM hp_warranty_cache
      WHERE serial = $1
      LIMIT 1
    `,
    [serial],
  );
  const row = result.rows[0];
  return row ? mapWarrantyCacheEntry(row) : null;
}

export async function findCachedWarranties(
  serials: readonly string[],
): Promise<WarrantyCacheEntry[]> {
  if (serials.length === 0) {
    return [];
  }

  const result = await query<WarrantyCacheRow>(
    `
      SELECT ${WARRANTY_CACHE_COLUMNS}
      FROM hp_warranty_cache
      WHERE serial = ANY($1::VARCHAR[])
    `,
    [[...serials]],
  );

  return result.rows.map(mapWarrantyCacheEntry);
}

export interface UpsertWarrantyCacheInput {
  serial: string;
  lookupStatus: CachedWarrantyStatus;
  endDate: string | null;
  productNumber: string | null;
  hpStatus: string | null;
}

export async function upsertWarrantyCache(
  input: UpsertWarrantyCacheInput,
): Promise<WarrantyCacheEntry> {
  const result = await query<WarrantyCacheRow>(
    `
      INSERT INTO hp_warranty_cache (
        serial, lookup_status, end_date, product_number, hp_status, fetched_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (serial) DO UPDATE
      SET
        lookup_status = EXCLUDED.lookup_status,
        end_date = EXCLUDED.end_date,
        product_number = EXCLUDED.product_number,
        hp_status = EXCLUDED.hp_status,
        fetched_at = NOW()
      RETURNING ${WARRANTY_CACHE_COLUMNS}
    `,
    [
      input.serial,
      input.lookupStatus,
      input.endDate,
      input.productNumber,
      input.hpStatus,
    ],
  );

  return mapWarrantyCacheEntry(result.rows[0]!);
}
