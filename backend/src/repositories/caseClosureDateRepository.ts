import type { PoolClient } from "pg";
import { pool, query } from "../config/database.js";

/**
 * Imported case closure dates (from the Flex Closure ASP Report). Keyed by WO id and
 * Case id; a report row is matched by WO id first, then Case id.
 */

export interface CaseClosureDateInput {
  woId: string;
  caseId: string;
  /** YYYY-MM-DD */
  closureDate: string;
}

/** Normalises a lookup key exactly the way both writes and reads must agree on. */
export function normalizeKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * Replaces the whole closure-date set with `rows` in a single transaction, so an import
 * is all-or-nothing and re-importing fully refreshes the data. Rows are upserted by WO id
 * and by Case id independently, so either key can match later.
 */
export async function replaceCaseClosureDates(
  rows: readonly CaseClosureDateInput[],
): Promise<number> {
  // The source report can repeat a WO id / Case id across rows. De-duplicate before
  // insert (last occurrence wins) so a single key never collides with the unique
  // indexes, and drop any later row that reuses a WO id or Case id already taken.
  const seenWo = new Set<string>();
  const seenCase = new Set<string>();
  const deduped: Array<{ woId: string; caseId: string; closureDate: string }> = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const woId = normalizeKey(row.woId);
    const caseId = normalizeKey(row.caseId);
    if (!woId && !caseId) continue; // nothing to match on
    if (woId && seenWo.has(woId)) continue; // WO id already taken by a later row
    if (caseId && seenCase.has(caseId)) continue; // Case id already taken
    if (woId) seenWo.add(woId);
    if (caseId) seenCase.add(caseId);
    deduped.push({ woId, caseId, closureDate: row.closureDate });
  }

  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM case_closure_dates");

    for (const row of deduped) {
      await client.query(
        `INSERT INTO case_closure_dates (wo_id, case_id, closure_date, updated_at)
         VALUES ($1, $2, $3::date, NOW())`,
        [row.woId, row.caseId, row.closureDate],
      );
    }

    await client.query("COMMIT");
    return deduped.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface ClosureDateLookup {
  byWoId: Map<string, string>;
  byCaseId: Map<string, string>;
}

/**
 * Loads every closure date into two lookup maps (WO id → date, Case id → date) as
 * DD-MM-YYYY strings, matching the Closed Calls table's date display format.
 */
export async function loadClosureDateLookup(): Promise<ClosureDateLookup> {
  const result = await query<{
    wo_id: string;
    case_id: string;
    closure_date: string;
  }>(
    `SELECT wo_id, case_id, to_char(closure_date, 'DD-MM-YYYY') AS closure_date
     FROM case_closure_dates`,
  );

  const byWoId = new Map<string, string>();
  const byCaseId = new Map<string, string>();
  for (const row of result.rows) {
    if (row.wo_id) byWoId.set(row.wo_id, row.closure_date);
    if (row.case_id) byCaseId.set(row.case_id, row.closure_date);
  }
  return { byWoId, byCaseId };
}

export async function countCaseClosureDates(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM case_closure_dates`,
  );
  return Number(result.rows[0]?.count ?? 0);
}
