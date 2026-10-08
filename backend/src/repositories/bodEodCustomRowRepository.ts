import { query } from "../config/database.js";

export interface BodEodCustomRowRecord {
  id: string;
  key: string;
  label: string;
  productivityBucket: string;
  afterRow: string;
  sortOrder: number;
  isActive: boolean;
  /** How many RTPL statuses point at this row. */
  statusCount: number;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  row_key: string;
  label: string;
  productivity_bucket: string;
  after_row: string;
  sort_order: number;
  is_active: boolean;
  status_count: string | number;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `
  r.id,
  r.row_key,
  r.label,
  r.productivity_bucket,
  r.after_row,
  r.sort_order,
  r.is_active,
  (SELECT COUNT(*) FROM rtpl_statuses s WHERE s.bod_eod_bucket = r.row_key) AS status_count,
  r.created_at::TEXT AS created_at,
  r.updated_at::TEXT AS updated_at
`;

function map(row: Row): BodEodCustomRowRecord {
  return {
    id: row.id,
    key: row.row_key,
    label: row.label,
    productivityBucket: row.productivity_bucket,
    afterRow: row.after_row,
    sortOrder: Number(row.sort_order),
    isActive: Boolean(row.is_active),
    statusCount: Number(row.status_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listBodEodCustomRows(): Promise<BodEodCustomRowRecord[]> {
  const result = await query<Row>(
    `SELECT ${COLUMNS} FROM bod_eod_custom_rows r ORDER BY r.sort_order ASC, r.label ASC`,
  );
  return result.rows.map(map);
}

export async function findBodEodCustomRowById(id: string): Promise<BodEodCustomRowRecord | null> {
  const result = await query<Row>(
    `SELECT ${COLUMNS} FROM bod_eod_custom_rows r WHERE r.id = $1 LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  return row ? map(row) : null;
}

export async function findBodEodCustomRowByKey(key: string): Promise<BodEodCustomRowRecord | null> {
  const result = await query<Row>(
    `SELECT ${COLUMNS} FROM bod_eod_custom_rows r WHERE r.row_key = $1 LIMIT 1`,
    [key],
  );
  const row = result.rows[0];
  return row ? map(row) : null;
}

export async function findBodEodCustomRowByLabel(label: string): Promise<BodEodCustomRowRecord | null> {
  const result = await query<Row>(
    `SELECT ${COLUMNS} FROM bod_eod_custom_rows r WHERE lower(r.label) = lower($1) LIMIT 1`,
    [label],
  );
  const row = result.rows[0];
  return row ? map(row) : null;
}

export async function insertBodEodCustomRow(input: {
  key: string;
  label: string;
  productivityBucket: string;
  afterRow: string;
  createdBy: string;
}): Promise<BodEodCustomRowRecord> {
  const result = await query<{ id: string }>(
    `
      INSERT INTO bod_eod_custom_rows (
        row_key, label, productivity_bucket, after_row, sort_order, created_by, updated_by
      )
      VALUES (
        $1, $2, $3, $4,
        (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM bod_eod_custom_rows),
        $5, $5
      )
      RETURNING id
    `,
    [input.key, input.label, input.productivityBucket, input.afterRow, input.createdBy],
  );
  return (await findBodEodCustomRowById(result.rows[0]!.id))!;
}

export async function updateBodEodCustomRow(
  id: string,
  input: {
    label?: string;
    productivityBucket?: string;
    afterRow?: string;
    sortOrder?: number;
    isActive?: boolean;
    updatedBy: string;
  },
): Promise<BodEodCustomRowRecord | null> {
  const result = await query(
    `
      UPDATE bod_eod_custom_rows
      SET
        label = COALESCE($2, label),
        productivity_bucket = COALESCE($3, productivity_bucket),
        after_row = COALESCE($4, after_row),
        sort_order = COALESCE($5, sort_order),
        is_active = COALESCE($6, is_active),
        updated_by = $7,
        updated_at = NOW()
      WHERE id = $1
    `,
    [
      id,
      input.label ?? null,
      input.productivityBucket ?? null,
      input.afterRow ?? null,
      input.sortOrder ?? null,
      input.isActive ?? null,
      input.updatedBy,
    ],
  );
  if ((result.rowCount ?? 0) === 0) return null;
  return findBodEodCustomRowById(id);
}

export async function deleteBodEodCustomRow(id: string): Promise<boolean> {
  const result = await query(`DELETE FROM bod_eod_custom_rows WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

/** The statuses still pointing at a row: a row cannot be deleted while any do. */
export async function listStatusNamesForRow(key: string): Promise<string[]> {
  const result = await query<{ name: string }>(
    `SELECT name FROM rtpl_statuses WHERE bod_eod_bucket = $1 ORDER BY sort_order, name`,
    [key],
  );
  return result.rows.map((row) => row.name);
}
