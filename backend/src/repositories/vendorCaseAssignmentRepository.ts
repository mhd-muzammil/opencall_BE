import type { PoolClient } from "pg";
import { pool, query } from "../config/database.js";
import { getNormalizedTicketKey } from "../services/normalization/dedupeRowsByTicket.js";

/**
 * Vendor ↔ case assignments. A "case" is keyed by its NORMALIZED ticket id (the same key
 * the report generator dedupes on, via getNormalizedTicketKey), so an assignment survives
 * daily report regeneration. Raw ticket/case ids are kept for display and case-id fallback.
 */

/** Case-id normalisation — trim + upper, matching case_closure_dates. */
function normalizeCaseKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

export interface VendorCaseAssignment {
  id: string;
  vendorAccessId: string;
  normalizedTicketId: string;
  ticketId: string;
  normalizedCaseId: string;
  caseId: string;
  assignedAt: string;
}

interface AssignmentRow {
  id: string;
  vendor_access_id: string;
  normalized_ticket_id: string;
  ticket_id: string;
  normalized_case_id: string;
  case_id: string;
  assigned_at: string;
}

function mapAssignment(row: AssignmentRow): VendorCaseAssignment {
  return {
    id: row.id,
    vendorAccessId: row.vendor_access_id,
    normalizedTicketId: row.normalized_ticket_id,
    ticketId: row.ticket_id,
    normalizedCaseId: row.normalized_case_id,
    caseId: row.case_id,
    assignedAt: row.assigned_at,
  };
}

export interface AssignCaseInput {
  ticketId: string;
  caseId?: string | null;
}

/**
 * Assigns cases (by raw ticket/case id) to a vendor. Idempotent per (vendor, ticket) — a
 * re-assign of the same ticket is silently ignored. Returns how many NEW rows were added.
 */
export async function assignCasesToVendor(
  vendorAccessId: string,
  cases: readonly AssignCaseInput[],
  assignedBy: string,
): Promise<number> {
  // Normalise + de-duplicate the incoming list; drop entries with no usable ticket key.
  const seen = new Set<string>();
  const rows: Array<{ nTicket: string; ticket: string; nCase: string; caseId: string }> = [];
  for (const c of cases) {
    const nTicket = getNormalizedTicketKey(c.ticketId);
    if (!nTicket || seen.has(nTicket)) continue;
    seen.add(nTicket);
    rows.push({
      nTicket,
      ticket: String(c.ticketId ?? "").trim(),
      nCase: normalizeCaseKey(c.caseId),
      caseId: String(c.caseId ?? "").trim(),
    });
  }
  if (rows.length === 0) return 0;

  const client: PoolClient = await pool.connect();
  let inserted = 0;
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      const res = await client.query(
        `INSERT INTO vendor_case_assignments
           (vendor_access_id, normalized_ticket_id, ticket_id, normalized_case_id, case_id, assigned_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (vendor_access_id, normalized_ticket_id)
           WHERE normalized_ticket_id <> ''
           DO NOTHING`,
        [vendorAccessId, r.nTicket, r.ticket, r.nCase, r.caseId, assignedBy],
      );
      inserted += res.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return inserted;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Removes one assignment (by its id), scoped to the vendor so a stray id can't unassign
 *  another vendor's case. Returns true when a row was removed. */
export async function unassignCaseFromVendor(
  vendorAccessId: string,
  assignmentId: string,
): Promise<boolean> {
  const result = await query(
    `DELETE FROM vendor_case_assignments WHERE id = $1 AND vendor_access_id = $2`,
    [assignmentId, vendorAccessId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listAssignmentsForVendor(
  vendorAccessId: string,
): Promise<VendorCaseAssignment[]> {
  const result = await query<AssignmentRow>(
    `SELECT id, vendor_access_id, normalized_ticket_id, ticket_id,
            normalized_case_id, case_id, assigned_at
       FROM vendor_case_assignments
      WHERE vendor_access_id = $1
      ORDER BY assigned_at DESC`,
    [vendorAccessId],
  );
  return result.rows.map(mapAssignment);
}

/**
 * The set of keys a vendor is assigned, for filtering the in-memory report: normalized
 * ticket ids and (secondary) normalized case ids. A report row matches if EITHER its
 * normalized ticket key or its normalized case id is in the corresponding set.
 */
export async function loadAssignedKeysForVendor(
  vendorAccessId: string,
): Promise<{ ticketKeys: Set<string>; caseKeys: Set<string> }> {
  const result = await query<{ normalized_ticket_id: string; normalized_case_id: string }>(
    `SELECT normalized_ticket_id, normalized_case_id
       FROM vendor_case_assignments
      WHERE vendor_access_id = $1`,
    [vendorAccessId],
  );
  const ticketKeys = new Set<string>();
  const caseKeys = new Set<string>();
  for (const row of result.rows) {
    if (row.normalized_ticket_id) ticketKeys.add(row.normalized_ticket_id);
    if (row.normalized_case_id) caseKeys.add(row.normalized_case_id);
  }
  return { ticketKeys, caseKeys };
}

/** True when a specific ticket/case is assigned to the vendor (for the row-edit guard). */
export async function isCaseAssignedToVendor(
  vendorAccessId: string,
  ticketId: string | null | undefined,
  caseId: string | null | undefined,
): Promise<boolean> {
  const nTicket = getNormalizedTicketKey(ticketId);
  const nCase = normalizeCaseKey(caseId);
  const result = await query<{ one: number }>(
    `SELECT 1 AS one FROM vendor_case_assignments
      WHERE vendor_access_id = $1
        AND ( ($2 <> '' AND normalized_ticket_id = $2)
           OR ($3 <> '' AND normalized_case_id = $3) )
      LIMIT 1`,
    [vendorAccessId, nTicket, nCase],
  );
  return result.rows.length > 0;
}

/** Per-vendor assignment counts, for the admin monitoring page. */
export async function countAssignmentsByVendor(): Promise<Map<string, number>> {
  const result = await query<{ vendor_access_id: string; count: string }>(
    `SELECT vendor_access_id, COUNT(*)::TEXT AS count
       FROM vendor_case_assignments
      GROUP BY vendor_access_id`,
  );
  const counts = new Map<string, number>();
  for (const row of result.rows) {
    counts.set(row.vendor_access_id, Number(row.count));
  }
  return counts;
}
