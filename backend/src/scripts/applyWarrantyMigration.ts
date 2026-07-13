import { closeDatabasePool, pool } from "../config/database.js";

const sqlQueries = [
  // Permanent, cross-job cache: a serial is fetched from HP once, ever. Only
  // terminal results worth keeping land here (OK / NOT_FOUND) — FAILED must stay
  // retryable and NO_SERIAL never reaches HP at all.
  `CREATE TABLE IF NOT EXISTS hp_warranty_cache (
      serial VARCHAR PRIMARY KEY,
      lookup_status VARCHAR NOT NULL,
      end_date DATE,
      product_number VARCHAR,
      hp_status VARCHAR,
      fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  );`,

  `CREATE TABLE IF NOT EXISTS warranty_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      original_file_name VARCHAR NOT NULL,
      stored_file_path VARCHAR NOT NULL,
      status VARCHAR NOT NULL DEFAULT 'pending',
      total_rows INTEGER NOT NULL DEFAULT 0,
      unique_serials INTEGER NOT NULL DEFAULT 0,
      created_by UUID REFERENCES users(id),
      region_id UUID REFERENCES regions(id),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  );`,

  `CREATE INDEX IF NOT EXISTS idx_warranty_jobs_created_by ON warranty_jobs(created_by);`,
  `CREATE INDEX IF NOT EXISTS idx_warranty_jobs_status ON warranty_jobs(status);`,

  // This table IS the queue. One row per unique serial per job; the worker claims
  // 'pending' rows with FOR UPDATE SKIP LOCKED.
  `CREATE TABLE IF NOT EXISTS warranty_job_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id UUID NOT NULL REFERENCES warranty_jobs(id) ON DELETE CASCADE,
      serial VARCHAR NOT NULL,
      product_number VARCHAR,
      state VARCHAR NOT NULL DEFAULT 'pending',
      lookup_status VARCHAR,
      end_date DATE,
      hp_status VARCHAR,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      locked_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      UNIQUE (job_id, serial)
  );`,

  `CREATE INDEX IF NOT EXISTS idx_warranty_job_items_job_id ON warranty_job_items(job_id);`,
  // Queue index: the worker orders pending work by created_at.
  `CREATE INDEX IF NOT EXISTS idx_warranty_job_items_queue ON warranty_job_items(state, created_at);`,
];

async function run(): Promise<void> {
  const client = await pool.connect();

  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 023_hp_warranty_lookup.sql");
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
  .finally(() => {
    void closeDatabasePool();
  });
