import { query } from "../config/database.js";
import type { FieldezSlaRecord } from "../services/fieldezSla/fieldezSlaParse.js";

/**
 * Where FieldEZ's answer about each call's SLA is kept between refreshes.
 *
 * Read by every screen that shows an SLA; written only by the FieldEZ worker. Nothing here
 * asks FieldEZ anything — that is the worker's job, and keeping the two apart is what stops
 * a slow mail server or a lapsed FieldEZ session from making the Open Call Report slow.
 */

export interface StoredSla {
  ticketKey: string;
  ticketNo: string;
  caseId: string;
  fieldezTicketId: number | null;
  bpId: number | null;
  slaStatus: string;
  slaPolicy: string;
  /** ISO. Null for a ticket FieldEZ tracks no SLA on. */
  slaEndTime: string | null;
  priority: string;
  taskName: string;
  fetchedAt: string;
}

/**
 * Write what the worker just read, in one statement.
 *
 * One statement rather than a loop because a sweep carries the better part of a thousand
 * rows and a thousand round trips is most of the sweep's time. Built as a VALUES list with
 * numbered parameters — never interpolated — so a customer name with an apostrophe in it
 * stays a customer name.
 *
 * Existing rows are overwritten wholesale, which is right: this table is a mirror of what
 * FieldEZ says now, and a field that has gone empty there has genuinely gone empty. Merging
 * would preserve a stale "Within SLA" on a ticket whose SLA was removed.
 */
export async function upsertSlaRecords(records: readonly FieldezSlaRecord[]): Promise<number> {
  if (records.length === 0) return 0;

  const values: unknown[] = [];
  const rows: string[] = [];
  for (const record of records) {
    const base = values.length;
    rows.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
        `$${base + 6}, $${base + 7}, $${base + 8}::timestamptz, $${base + 9}, $${base + 10}, NOW())`,
    );
    values.push(
      record.ticketKey,
      record.ticketNo,
      record.caseId,
      record.fieldezTicketId,
      record.bpId,
      record.slaStatus,
      record.slaPolicy,
      record.slaEndTime ? record.slaEndTime.toISOString() : null,
      record.priority,
      record.taskName,
    );
  }

  const result = await query(
    `INSERT INTO fieldez_sla (
        ticket_key, ticket_no, case_id, fieldez_ticket_id, bp_id,
        sla_status, sla_policy, sla_end_time, priority, task_name, fetched_at
     ) VALUES ${rows.join(", ")}
     ON CONFLICT (ticket_key) DO UPDATE SET
        ticket_no = EXCLUDED.ticket_no,
        case_id = EXCLUDED.case_id,
        fieldez_ticket_id = EXCLUDED.fieldez_ticket_id,
        bp_id = EXCLUDED.bp_id,
        sla_status = EXCLUDED.sla_status,
        sla_policy = EXCLUDED.sla_policy,
        sla_end_time = EXCLUDED.sla_end_time,
        priority = EXCLUDED.priority,
        task_name = EXCLUDED.task_name,
        fetched_at = EXCLUDED.fetched_at`,
    values,
  );
  return result.rowCount ?? 0;
}

function toStored(row: Record<string, unknown>): StoredSla {
  return {
    ticketKey: String(row["ticket_key"] ?? ""),
    ticketNo: String(row["ticket_no"] ?? ""),
    caseId: String(row["case_id"] ?? ""),
    fieldezTicketId: row["fieldez_ticket_id"] === null ? null : Number(row["fieldez_ticket_id"]),
    bpId: row["bp_id"] === null ? null : Number(row["bp_id"]),
    slaStatus: String(row["sla_status"] ?? ""),
    slaPolicy: String(row["sla_policy"] ?? ""),
    slaEndTime: row["sla_end_time"] === null ? null : String(row["sla_end_time"]),
    priority: String(row["priority"] ?? ""),
    taskName: String(row["task_name"] ?? ""),
    fetchedAt: String(row["fetched_at"] ?? ""),
  };
}

const SELECT_COLUMNS = `ticket_key, ticket_no, case_id, fieldez_ticket_id, bp_id,
        sla_status, sla_policy, sla_end_time::TEXT AS sla_end_time,
        priority, task_name, fetched_at::TEXT AS fetched_at`;

/**
 * Everything held, for the screens that show an SLA beside every call.
 *
 * The whole table on purpose: it has one row per open call, so it is the same size as the
 * report it decorates, and the alternative — a request carrying nine hundred ticket ids —
 * costs more than it saves.
 */
export async function listAllSla(): Promise<StoredSla[]> {
  const result = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM fieldez_sla ORDER BY sla_end_time NULLS LAST`,
  );
  return result.rows.map(toStored);
}

/** One call's SLA, for a page that shows a single ticket. */
export async function findSlaByTicket(ticketKey: string): Promise<StoredSla | null> {
  if (!ticketKey.trim()) return null;
  const result = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM fieldez_sla WHERE ticket_key = $1`,
    [ticketKey.trim().toUpperCase()],
  );
  const row = result.rows[0];
  return row ? toStored(row) : null;
}

export interface SlaFreshness {
  rows: number;
  /** ISO of the most recent refresh, or null when nothing has ever been written. */
  lastFetchedAt: string | null;
  withSla: number;
}

/**
 * How much is held and how old it is.
 *
 * Shown next to the numbers rather than kept for diagnostics. An SLA figure carries a date
 * inside it, so one drawn from a table that stopped being refreshed on Tuesday is not merely
 * out of date — it is confidently wrong, and it looks exactly like a current one.
 */
export async function getSlaFreshness(): Promise<SlaFreshness> {
  const result = await query<{ rows: string; last_fetched_at: string | null; with_sla: string }>(
    `SELECT COUNT(*)::TEXT AS rows,
            MAX(fetched_at)::TEXT AS last_fetched_at,
            COUNT(*) FILTER (WHERE sla_end_time IS NOT NULL)::TEXT AS with_sla
       FROM fieldez_sla`,
  );
  const row = result.rows[0];
  return {
    rows: Number(row?.rows ?? 0),
    lastFetchedAt: row?.last_fetched_at ?? null,
    withSla: Number(row?.with_sla ?? 0),
  };
}

/**
 * Forget calls FieldEZ no longer lists as open.
 *
 * A closed call keeps its row for ever otherwise, and its long-expired deadline goes on
 * counting as a breach in every total. Only rows NOT in the sweep's list are removed, and
 * only when the sweep actually returned something — an empty list means the fetch failed,
 * and treating that as "every call is closed" would empty the table on the first bad night.
 */
export async function deleteSlaMissingFrom(ticketKeys: readonly string[]): Promise<number> {
  if (ticketKeys.length === 0) return 0;
  const result = await query(
    `DELETE FROM fieldez_sla WHERE ticket_key <> ALL($1::TEXT[])`,
    [ticketKeys],
  );
  return result.rowCount ?? 0;
}
