import { closeDatabasePool, pool } from "../config/database.js";

// Mirrors infra/postgres/migrations/044_customer_address.sql. Every statement is
// idempotent, so re-running is safe.
//
// Promotes the Flex WIP address columns out of `raw_row` into real columns.
// Reading them through `raw_row->>'Customer Address'` ties the whole feature to
// the exact header string FieldEZ emits, and a rename there fails silently —
// the key stops matching, every lookup returns NULL, and nothing errors.
//
// No behaviour change: nothing reads these columns yet.
const sqlQueries = [
  // City and state come along because a geocoder disambiguates on them, and a
  // second migration against the same table for the same feature is waste.
  `ALTER TABLE flex_wip_records
     ADD COLUMN IF NOT EXISTS customer_address TEXT,
     ADD COLUMN IF NOT EXISTS common_address   TEXT,
     ADD COLUMN IF NOT EXISTS customer_city    TEXT,
     ADD COLUMN IF NOT EXISTS customer_state   TEXT;`,

  `COMMENT ON COLUMN flex_wip_records.customer_address IS
     'FieldEZ "Customer Address". Frequently truncated (~62 chars) and occasionally holds a different site than the work order — never trust it over common_address without scoring both (see addressSelector).';`,

  `COMMENT ON COLUMN flex_wip_records.common_address IS
     'FieldEZ "Common Address". Measured as the more complete of the two on most rows, and present on rows where customer_address is blank.';`,

  // Backfill from the JSON that already holds this data, so coverage numbers are
  // available immediately rather than one upload cycle from now. Guarded on all
  // four being NULL so a re-run never clobbers values the parser has since
  // written.
  `UPDATE flex_wip_records
      SET customer_address = COALESCE(
            NULLIF(TRIM(raw_row->>'Customer Address'), ''),
            NULLIF(TRIM(raw_row->>'CustomerAddress'), '')
          ),
          common_address = COALESCE(
            NULLIF(TRIM(raw_row->>'Common Address'), ''),
            NULLIF(TRIM(raw_row->>'CommonAddress'), '')
          ),
          customer_city = COALESCE(
            NULLIF(TRIM(raw_row->>'Customer City'), ''),
            NULLIF(TRIM(raw_row->>'CustomerCity'), '')
          ),
          customer_state = COALESCE(
            NULLIF(TRIM(raw_row->>'Customer State'), ''),
            NULLIF(TRIM(raw_row->>'CustomerState'), '')
          )
    WHERE customer_address IS NULL
      AND common_address IS NULL
      AND customer_city IS NULL
      AND customer_state IS NULL;`,

  // The Phase 1 sweep asks "which records still have an unresolved address".
  // Indexing only rows that HAVE one keeps it small.
  `CREATE INDEX IF NOT EXISTS idx_flex_wip_has_address
     ON flex_wip_records (normalized_ticket_id)
     WHERE customer_address IS NOT NULL OR common_address IS NOT NULL;`,
];

async function run(): Promise<void> {
  const client = await pool.connect();

  try {
    for (const sql of sqlQueries) {
      await client.query(sql);
    }
    console.log("Applied migration 044_customer_address.sql");
  } catch (error) {
    console.error("Migration failed:", error);
    throw error;
  } finally {
    client.release();
  }
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
