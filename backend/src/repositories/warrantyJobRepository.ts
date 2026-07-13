import type { WarrantyJobStatus } from "@opencall/shared";
import { query } from "../config/database.js";

export interface WarrantyJobRow {
  id: string;
  original_file_name: string;
  stored_file_path: string;
  status: WarrantyJobStatus;
  total_rows: number;
  unique_serials: number;
  created_by: string | null;
  region_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WarrantyJobRecord {
  id: string;
  originalFileName: string;
  /** Absolute-or-relative path of the uploaded source workbook. Never mutated. */
  storedFilePath: string;
  status: WarrantyJobStatus;
  totalRows: number;
  uniqueSerials: number;
  createdBy: string | null;
  regionId: string | null;
  createdAt: string;
  updatedAt: string;
}

const WARRANTY_JOB_COLUMNS = `
  id,
  original_file_name,
  stored_file_path,
  status,
  total_rows,
  unique_serials,
  created_by,
  region_id,
  created_at::TEXT AS created_at,
  updated_at::TEXT AS updated_at
`;

function mapWarrantyJob(row: WarrantyJobRow): WarrantyJobRecord {
  return {
    id: row.id,
    originalFileName: row.original_file_name,
    storedFilePath: row.stored_file_path,
    status: row.status,
    totalRows: Number(row.total_rows),
    uniqueSerials: Number(row.unique_serials),
    createdBy: row.created_by,
    regionId: row.region_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InsertWarrantyJobInput {
  originalFileName: string;
  storedFilePath: string;
  status: WarrantyJobStatus;
  totalRows: number;
  uniqueSerials: number;
  createdBy: string;
  regionId: string | null;
}

export async function insertWarrantyJob(
  input: InsertWarrantyJobInput,
): Promise<WarrantyJobRecord> {
  const result = await query<WarrantyJobRow>(
    `
      INSERT INTO warranty_jobs (
        original_file_name,
        stored_file_path,
        status,
        total_rows,
        unique_serials,
        created_by,
        region_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING ${WARRANTY_JOB_COLUMNS}
    `,
    [
      input.originalFileName,
      input.storedFilePath,
      input.status,
      input.totalRows,
      input.uniqueSerials,
      input.createdBy,
      input.regionId,
    ],
  );

  return mapWarrantyJob(result.rows[0]!);
}

export async function findWarrantyJobById(
  id: string,
): Promise<WarrantyJobRecord | null> {
  const result = await query<WarrantyJobRow>(
    `
      SELECT ${WARRANTY_JOB_COLUMNS}
      FROM warranty_jobs
      WHERE id = $1
      LIMIT 1
    `,
    [id],
  );
  const row = result.rows[0];
  return row ? mapWarrantyJob(row) : null;
}

export async function updateWarrantyJobStatus(
  id: string,
  status: WarrantyJobStatus,
): Promise<WarrantyJobRecord | null> {
  const result = await query<WarrantyJobRow>(
    `
      UPDATE warranty_jobs
      SET status = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING ${WARRANTY_JOB_COLUMNS}
    `,
    [id, status],
  );
  const row = result.rows[0];
  return row ? mapWarrantyJob(row) : null;
}
