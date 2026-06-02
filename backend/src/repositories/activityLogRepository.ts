import { query } from "../config/database.js";
import type { UserRole } from "@opencall/shared";

export type ActivityEventType =
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILED"
  | "LOGOUT"
  | "PASSWORD_CHANGED"
  | "PASSWORD_RESET"
  | "USER_CREATED"
  | "USER_PROFILE_UPDATED"
  | "USER_ROLE_CHANGED"
  | "USER_REGION_REASSIGNED"
  | "USER_DEACTIVATED"
  | "USER_REACTIVATED"
  | "UPLOAD_CREATED"
  | "REPORT_GENERATED"
  | "REPORT_ROW_EDITED"
  | "ENGINEER_CREATED"
  | "ENGINEER_UPDATED"
  | "ENGINEER_DEACTIVATED";

export type ActivityStatus = "SUCCESS" | "FAILURE";

export interface InsertActivityInput {
  actorUserId: string | null;
  actorEmail: string | null;
  actorRole: UserRole | null;
  regionId: string | null;
  eventType: ActivityEventType;
  targetType: string | null;
  targetId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  status: ActivityStatus;
}

export interface ActivityRow {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorRole: UserRole | null;
  regionId: string | null;
  eventType: ActivityEventType;
  targetType: string | null;
  targetId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  status: ActivityStatus;
  actorUsername: string | null;
  regionCode: string | null;
  regionName: string | null;
}

export interface RtplStatusChangeActivity {
  id: string;
  rowId: string;
  reportId: string;
  serialNo: number;
  ticketId: string;
  caseId: string | null;
  workLocation: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  changedAt: string;
  changedBy: string | null;
}

interface ActivityRowDb {
  id: string;
  occurred_at: string;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_role: UserRole | null;
  region_id: string | null;
  event_type: ActivityEventType;
  target_type: string | null;
  target_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  status: ActivityStatus;
  actor_username: string | null;
  region_code: string | null;
  region_name: string | null;
}

interface RtplStatusChangeActivityDb {
  id: string;
  row_id: string;
  report_id: string;
  serial_no: string | null;
  ticket_id: string | null;
  case_id: string | null;
  work_location: string | null;
  from_status: string | null;
  to_status: string | null;
  changed_at: string;
  changed_by: string | null;
}

function mapActivityRow(row: ActivityRowDb): ActivityRow {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actorUserId: row.actor_user_id,
    actorEmail: row.actor_email,
    actorRole: row.actor_role,
    regionId: row.region_id,
    eventType: row.event_type,
    targetType: row.target_type,
    targetId: row.target_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    metadata: row.metadata ?? {},
    status: row.status,
    actorUsername: row.actor_username,
    regionCode: row.region_code,
    regionName: row.region_name,
  };
}

function mapRtplStatusChangeActivity(
  row: RtplStatusChangeActivityDb,
): RtplStatusChangeActivity {
  return {
    id: row.id,
    rowId: row.row_id,
    reportId: row.report_id,
    serialNo: Number(row.serial_no ?? "0"),
    ticketId: row.ticket_id ?? "",
    caseId: row.case_id,
    workLocation: row.work_location,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    changedAt: row.changed_at,
    changedBy: row.changed_by,
  };
}

export async function insertActivity(input: InsertActivityInput): Promise<void> {
  await query(
    `
      INSERT INTO user_activity_log (
        actor_user_id, actor_email, actor_role, region_id,
        event_type, target_type, target_id,
        ip_address, user_agent, metadata, status
      )
      VALUES (
        $1, $2, $3::user_role, $4,
        $5::activity_event_type, $6, $7,
        $8::inet, $9, $10::jsonb, $11
      )
    `,
    [
      input.actorUserId,
      input.actorEmail,
      input.actorRole,
      input.regionId,
      input.eventType,
      input.targetType,
      input.targetId,
      input.ipAddress,
      input.userAgent,
      JSON.stringify(input.metadata ?? {}),
      input.status,
    ],
  );
}

export async function listRtplStatusChanges(filters: {
  reportId: string;
  regionId?: string | null;
  workLocationCodes?: readonly string[];
  limit?: number;
}): Promise<RtplStatusChangeActivity[]> {
  const conditions = [
    `a.event_type = 'REPORT_ROW_EDITED'::activity_event_type`,
    `a.status = 'SUCCESS'`,
    `a.metadata ? 'rtplStatusChange'`,
  ];
  const params: unknown[] = [filters.reportId];
  conditions.push(`a.metadata->>'reportId' = $1`);

  const workLocationCodes = (filters.workLocationCodes ?? [])
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);

  if (filters.regionId && workLocationCodes.length > 0) {
    params.push(filters.regionId);
    const regionParam = params.length;
    params.push(workLocationCodes);
    const codesParam = params.length;
    conditions.push(
      `(a.region_id = $${regionParam} OR UPPER(a.metadata->>'workLocation') = ANY($${codesParam}::text[]))`,
    );
  } else if (filters.regionId) {
    params.push(filters.regionId);
    conditions.push(`a.region_id = $${params.length}`);
  } else if (workLocationCodes.length > 0) {
    params.push(workLocationCodes);
    conditions.push(`UPPER(a.metadata->>'workLocation') = ANY($${params.length}::text[])`);
  }

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  params.push(limit);
  const limitParam = params.length;

  const result = await query<RtplStatusChangeActivityDb>(
    `
      SELECT
        a.id,
        a.target_id AS row_id,
        a.metadata->>'reportId' AS report_id,
        a.metadata->>'serialNo' AS serial_no,
        a.metadata->>'ticketId' AS ticket_id,
        a.metadata->>'caseId' AS case_id,
        a.metadata->>'workLocation' AS work_location,
        a.metadata#>>'{rtplStatusChange,fromStatus}' AS from_status,
        a.metadata#>>'{rtplStatusChange,toStatus}' AS to_status,
        a.occurred_at::TEXT AS changed_at,
        COALESCE(users.username, a.actor_email, a.actor_user_id::TEXT) AS changed_by
      FROM user_activity_log a
      LEFT JOIN users ON users.id = a.actor_user_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY a.occurred_at DESC, a.id DESC
      LIMIT $${limitParam}
    `,
    params,
  );

  return result.rows.map(mapRtplStatusChangeActivity);
}

export interface ActivityFilters {
  regionId?: string | null;
  actorUserId?: string;
  eventType?: ActivityEventType;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface ListActivityResult {
  rows: ActivityRow[];
  total: number;
}

export async function listActivity(
  filters: ActivityFilters,
): Promise<ListActivityResult> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.regionId === null) {
    conditions.push(`a.region_id IS NULL`);
  } else if (filters.regionId) {
    params.push(filters.regionId);
    conditions.push(`a.region_id = $${params.length}`);
  }
  if (filters.actorUserId) {
    params.push(filters.actorUserId);
    conditions.push(`a.actor_user_id = $${params.length}`);
  }
  if (filters.eventType) {
    params.push(filters.eventType);
    conditions.push(`a.event_type = $${params.length}::activity_event_type`);
  }
  if (filters.from) {
    params.push(filters.from);
    conditions.push(`a.occurred_at >= $${params.length}::timestamptz`);
  }
  if (filters.to) {
    params.push(filters.to);
    conditions.push(`a.occurred_at < $${params.length}::timestamptz`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  const totalResult = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM user_activity_log a ${where}`,
    params,
  );

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const rowsResult = await query<ActivityRowDb>(
    `
      SELECT
        a.id,
        a.occurred_at::TEXT AS occurred_at,
        a.actor_user_id,
        a.actor_email,
        a.actor_role,
        a.region_id,
        a.event_type,
        a.target_type,
        a.target_id,
        host(a.ip_address) AS ip_address,
        a.user_agent,
        a.metadata,
        a.status,
        users.username AS actor_username,
        regions.code   AS region_code,
        regions.name   AS region_name
      FROM user_activity_log a
      LEFT JOIN users   ON users.id   = a.actor_user_id
      LEFT JOIN regions ON regions.id = a.region_id
      ${where}
      ORDER BY a.occurred_at DESC, a.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `,
    params,
  );

  return {
    rows: rowsResult.rows.map(mapActivityRow),
    total: Number(totalResult.rows[0]?.count ?? "0"),
  };
}

export interface ActivityCountByRegion {
  regionId: string | null;
  regionCode: string | null;
  regionName: string | null;
  eventType: ActivityEventType;
  count: number;
}

export async function countByRegionAndEvent(
  since: string,
): Promise<ActivityCountByRegion[]> {
  const result = await query<{
    region_id: string | null;
    region_code: string | null;
    region_name: string | null;
    event_type: ActivityEventType;
    count: string;
  }>(
    `
      SELECT
        a.region_id,
        regions.code AS region_code,
        regions.name AS region_name,
        a.event_type,
        COUNT(*)::TEXT AS count
      FROM user_activity_log a
      LEFT JOIN regions ON regions.id = a.region_id
      WHERE a.occurred_at >= $1::timestamptz
      GROUP BY a.region_id, regions.code, regions.name, a.event_type
    `,
    [since],
  );
  return result.rows.map((row) => ({
    regionId: row.region_id,
    regionCode: row.region_code,
    regionName: row.region_name,
    eventType: row.event_type,
    count: Number(row.count ?? "0"),
  }));
}

export interface LastEventTimestamps {
  actorUserId: string | null;
  regionId: string | null;
  lastLoginAt: string | null;
  lastUploadAt: string | null;
  lastReportAt: string | null;
  lastEditAt: string | null;
}

export async function lastEventTimestampsByRegion(): Promise<LastEventTimestamps[]> {
  const result = await query<{
    region_id: string | null;
    last_login_at: string | null;
    last_upload_at: string | null;
    last_report_at: string | null;
    last_edit_at: string | null;
  }>(
    `
      SELECT
        region_id,
        MAX(CASE WHEN event_type = 'LOGIN_SUCCESS'      THEN occurred_at END)::TEXT AS last_login_at,
        MAX(CASE WHEN event_type = 'UPLOAD_CREATED'     THEN occurred_at END)::TEXT AS last_upload_at,
        MAX(CASE WHEN event_type = 'REPORT_GENERATED'   THEN occurred_at END)::TEXT AS last_report_at,
        MAX(CASE WHEN event_type = 'REPORT_ROW_EDITED'  THEN occurred_at END)::TEXT AS last_edit_at
      FROM user_activity_log
      GROUP BY region_id
    `,
  );
  return result.rows.map((row) => ({
    actorUserId: null,
    regionId: row.region_id,
    lastLoginAt: row.last_login_at,
    lastUploadAt: row.last_upload_at,
    lastReportAt: row.last_report_at,
    lastEditAt: row.last_edit_at,
  }));
}
