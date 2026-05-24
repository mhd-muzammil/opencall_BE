import type { UploadSourceType } from "@opencall/shared";
import type { PoolClient } from "pg";
import type {
  CreateUploadBatchInput,
  UploadBatchRecord,
} from "../types/upload.js";

interface UploadBatchRow {
  id: string;
  source_type: UploadBatchRecord["sourceType"];
  original_file_name: string;
  status: UploadBatchRecord["status"];
  row_count: number;
  error_count: number;
  created_at: Date | string;
}

export interface UploadBatchValidationRecord {
  id: string;
  sourceType: UploadSourceType;
  status: UploadBatchRecord["status"];
  rowCount: number;
  errorCount: number;
  regionId: string | null;
  uploaderRole: "SUPER_ADMIN" | "REGION_ADMIN" | null;
}

interface UploadBatchValidationRow {
  id: string;
  source_type: UploadSourceType;
  status: UploadBatchRecord["status"];
  row_count: number;
  error_count: number;
  region_id: string | null;
  uploader_role: "SUPER_ADMIN" | "REGION_ADMIN" | null;
}

export async function createUploadBatch(
  input: CreateUploadBatchInput,
  client: PoolClient,
): Promise<UploadBatchRecord> {
  const errorCount = input.errors.length;
  const status = errorCount === 0 ? "VALIDATED" : "FAILED";

  const result = await client.query<UploadBatchRow>(
    `
      INSERT INTO source_upload_batches (
        source_type,
        original_file_name,
        stored_file_path,
        status,
        uploaded_by,
        region_id,
        row_count,
        error_count,
        errors
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      RETURNING
        id,
        source_type,
        original_file_name,
        status,
        row_count,
        error_count,
        created_at
    `,
    [
      input.sourceType,
      input.originalFileName,
      input.storedFilePath,
      status,
      input.uploadedBy,
      input.regionId,
      input.rowCount,
      errorCount,
      JSON.stringify(input.errors),
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Upload batch insert did not return a row");
  }

  return {
    id: row.id,
    sourceType: row.source_type,
    originalFileName: row.original_file_name,
    status: row.status,
    rowCount: row.row_count,
    errorCount: row.error_count,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
  };
}

export async function findUploadBatchesForValidation(
  client: PoolClient,
  uploadBatchIds: readonly string[],
): Promise<UploadBatchValidationRecord[]> {
  const result = await client.query<UploadBatchValidationRow>(
    `
      SELECT
        batches.id,
        batches.source_type,
        batches.status,
        batches.row_count,
        batches.error_count,
        batches.region_id,
        users.role AS uploader_role
      FROM source_upload_batches batches
      LEFT JOIN users ON users.id = batches.uploaded_by
      WHERE batches.id = ANY($1::uuid[])
      FOR SHARE OF batches
    `,
    [uploadBatchIds],
  );

  return result.rows.map((row) => ({
    id: row.id,
    sourceType: row.source_type,
    status: row.status,
    rowCount: row.row_count,
    errorCount: row.error_count,
    regionId: row.region_id,
    uploaderRole: row.uploader_role,
  }));
}
