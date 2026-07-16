import { query } from "../config/database.js";
import { normalizeKey } from "./caseClosureDateRepository.js";

/**
 * Customer feedback captured against a closed call. Keyed by WO id and Case id; a report
 * row is matched by WO id first, then Case id. Re-saving upserts on both keys.
 *
 * Uniform dropdown values (call_status + feedback) plus optional free-text remarks, so
 * the derived Customer Status can be charted cleanly.
 */

export interface CustomerFeedback {
  callStatus: string;
  feedback: string;
  remarks: string;
  updatedBy: string;
  updatedAt: string;
}

export interface UpsertCustomerFeedbackInput {
  woId: string;
  caseId: string;
  callStatus: string;
  feedback: string;
  remarks: string;
  updatedBy: string;
}

export async function upsertCustomerFeedback(
  input: UpsertCustomerFeedbackInput,
): Promise<void> {
  const woId = normalizeKey(input.woId);
  const caseId = normalizeKey(input.caseId);
  if (!woId && !caseId) {
    throw new Error("Customer feedback needs a WO id or Case id");
  }

  // Remove any prior feedback for either key so a re-save cleanly replaces it (the two
  // partial unique indexes are enforced independently, so we clear both then insert).
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (woId) {
    params.push(woId);
    conditions.push(`wo_id = $${params.length}`);
  }
  if (caseId) {
    params.push(caseId);
    conditions.push(`case_id = $${params.length}`);
  }
  await query(
    `DELETE FROM case_customer_feedback WHERE ${conditions.join(" OR ")}`,
    params,
  );

  await query(
    `INSERT INTO case_customer_feedback
       (wo_id, case_id, call_status, feedback, remarks, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [woId, caseId, input.callStatus, input.feedback, input.remarks, input.updatedBy],
  );
}

export interface FeedbackLookup {
  byWoId: Map<string, CustomerFeedback>;
  byCaseId: Map<string, CustomerFeedback>;
}

/** Loads all feedback into WO-id and Case-id lookup maps. */
export async function loadCustomerFeedbackLookup(): Promise<FeedbackLookup> {
  const result = await query<{
    wo_id: string;
    case_id: string;
    call_status: string;
    feedback: string;
    remarks: string;
    updated_by: string;
    updated_at: string;
  }>(
    `SELECT wo_id, case_id, call_status, feedback, remarks, updated_by,
            updated_at::TEXT AS updated_at
     FROM case_customer_feedback`,
  );

  const byWoId = new Map<string, CustomerFeedback>();
  const byCaseId = new Map<string, CustomerFeedback>();
  for (const row of result.rows) {
    const fb: CustomerFeedback = {
      callStatus: row.call_status,
      feedback: row.feedback,
      remarks: row.remarks,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    };
    if (row.wo_id) byWoId.set(row.wo_id, fb);
    if (row.case_id) byCaseId.set(row.case_id, fb);
  }
  return { byWoId, byCaseId };
}
