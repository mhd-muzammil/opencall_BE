import type { PoolClient } from "pg";
import type {
  EngineerProductivityResult,
  RegionEodStatus,
} from "@opencall/shared";
import { query } from "../config/database.js";

export interface RegionEodStateRecord {
  id: string;
  regionId: string;
  workingDate: string;
  status: RegionEodStatus;
  closedAt: string | null;
  closedBy: string | null;
  /** Display name (email or username) of the closer; null while OPEN. */
  closedByDisplay: string | null;
}

interface RegionEodStateRow {
  id: string;
  region_id: string;
  working_date: string;
  status: RegionEodStatus;
  closed_at: string | null;
  closed_by: string | null;
  closed_by_display: string | null;
}

const EOD_STATE_SELECT = `
  SELECT
    state.id,
    state.region_id,
    state.working_date::TEXT AS working_date,
    state.status,
    state.closed_at::TEXT AS closed_at,
    state.closed_by,
    COALESCE(users.email, users.username) AS closed_by_display
  FROM region_eod_state state
  LEFT JOIN users ON users.id = state.closed_by
`;

function mapEodState(row: RegionEodStateRow): RegionEodStateRecord {
  return {
    id: row.id,
    regionId: row.region_id,
    workingDate: row.working_date,
    status: row.status,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    closedByDisplay: row.closed_by_display,
  };
}

export async function findEodStatesForDate(
  workingDate: string,
): Promise<RegionEodStateRecord[]> {
  const result = await query<RegionEodStateRow>(
    `${EOD_STATE_SELECT} WHERE state.working_date = $1`,
    [workingDate],
  );
  return result.rows.map(mapEodState);
}

export async function findEodStateForUpdate(
  client: PoolClient,
  regionId: string,
  workingDate: string,
): Promise<RegionEodStateRecord | null> {
  // Row-lock WITHOUT the users join (FOR UPDATE cannot lock the nullable side
  // of an outer join); the display name is only needed on reads.
  const result = await client.query<Omit<RegionEodStateRow, "closed_by_display">>(
    `
      SELECT
        id,
        region_id,
        working_date::TEXT AS working_date,
        status,
        closed_at::TEXT AS closed_at,
        closed_by
      FROM region_eod_state
      WHERE region_id = $1 AND working_date = $2
      FOR UPDATE
    `,
    [regionId, workingDate],
  );
  const row = result.rows[0];
  return row ? mapEodState({ ...row, closed_by_display: null }) : null;
}

export async function markRegionEodClosed(
  client: PoolClient,
  regionId: string,
  workingDate: string,
  closedBy: string,
): Promise<RegionEodStateRecord> {
  const result = await client.query<Omit<RegionEodStateRow, "closed_by_display">>(
    `
      INSERT INTO region_eod_state (region_id, working_date, status, closed_at, closed_by)
      VALUES ($1, $2, 'CLOSED', NOW(), $3)
      ON CONFLICT (region_id, working_date) DO UPDATE
      SET
        status = 'CLOSED',
        closed_at = NOW(),
        closed_by = EXCLUDED.closed_by,
        updated_at = NOW()
      RETURNING
        id,
        region_id,
        working_date::TEXT AS working_date,
        status,
        closed_at::TEXT AS closed_at,
        closed_by
    `,
    [regionId, workingDate, closedBy],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Failed to mark region EOD closed");
  }
  return mapEodState({ ...row, closed_by_display: null });
}

export async function markRegionEodOpen(
  client: PoolClient,
  regionId: string,
  workingDate: string,
): Promise<RegionEodStateRecord | null> {
  const result = await client.query<Omit<RegionEodStateRow, "closed_by_display">>(
    `
      UPDATE region_eod_state
      SET status = 'OPEN', closed_at = NULL, closed_by = NULL, updated_at = NOW()
      WHERE region_id = $1 AND working_date = $2
      RETURNING
        id,
        region_id,
        working_date::TEXT AS working_date,
        status,
        closed_at::TEXT AS closed_at,
        closed_by
    `,
    [regionId, workingDate],
  );
  const row = result.rows[0];
  return row ? mapEodState({ ...row, closed_by_display: null }) : null;
}

export async function upsertProductivitySnapshot(
  client: PoolClient,
  regionId: string,
  workingDate: string,
  payload: EngineerProductivityResult,
): Promise<void> {
  await client.query(
    `
      INSERT INTO region_productivity_snapshot (region_id, working_date, payload)
      VALUES ($1, $2, $3::JSONB)
      ON CONFLICT (region_id, working_date) DO UPDATE
      SET payload = EXCLUDED.payload
    `,
    [regionId, workingDate, JSON.stringify(payload)],
  );
}

export async function deleteProductivitySnapshot(
  client: PoolClient,
  regionId: string,
  workingDate: string,
): Promise<void> {
  await client.query(
    `DELETE FROM region_productivity_snapshot WHERE region_id = $1 AND working_date = $2`,
    [regionId, workingDate],
  );
}

export interface RegionProductivitySnapshotRecord {
  regionId: string;
  workingDate: string;
  payload: EngineerProductivityResult;
  createdAt: string;
}

interface RegionProductivitySnapshotRow {
  region_id: string;
  working_date: string;
  payload: EngineerProductivityResult;
  created_at: string;
}

export async function findSnapshotsForDate(
  workingDate: string,
): Promise<RegionProductivitySnapshotRecord[]> {
  const result = await query<RegionProductivitySnapshotRow>(
    `
      SELECT
        region_id,
        working_date::TEXT AS working_date,
        payload,
        created_at::TEXT AS created_at
      FROM region_productivity_snapshot
      WHERE working_date = $1
    `,
    [workingDate],
  );
  return result.rows.map((row) => ({
    regionId: row.region_id,
    workingDate: row.working_date,
    payload: row.payload,
    createdAt: row.created_at,
  }));
}

export async function findSnapshot(
  client: PoolClient,
  regionId: string,
  workingDate: string,
): Promise<RegionProductivitySnapshotRecord | null> {
  const result = await client.query<RegionProductivitySnapshotRow>(
    `
      SELECT
        region_id,
        working_date::TEXT AS working_date,
        payload,
        created_at::TEXT AS created_at
      FROM region_productivity_snapshot
      WHERE region_id = $1 AND working_date = $2
      LIMIT 1
    `,
    [regionId, workingDate],
  );
  const row = result.rows[0];
  return row
    ? {
        regionId: row.region_id,
        workingDate: row.working_date,
        payload: row.payload,
        createdAt: row.created_at,
      }
    : null;
}
