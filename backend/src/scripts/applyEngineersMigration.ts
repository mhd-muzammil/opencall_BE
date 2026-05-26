import { closeDatabasePool, pool } from "../config/database.js";

const sqlQueries = [
    `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'ENGINEER_CREATED';`,
    `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'ENGINEER_UPDATED';`,
    `ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'ENGINEER_DEACTIVATED';`,
    
    `CREATE TABLE IF NOT EXISTS engineers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        engineer_code VARCHAR UNIQUE,
        engineer_name VARCHAR NOT NULL,
        region_id UUID NOT NULL REFERENCES regions(id),
        email VARCHAR,
        phone VARCHAR,
        is_active BOOLEAN DEFAULT true,
        created_by UUID REFERENCES users(id),
        updated_by UUID REFERENCES users(id),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );`,
    
    `CREATE INDEX IF NOT EXISTS idx_engineers_region_id ON engineers(region_id);`,
    `CREATE INDEX IF NOT EXISTS idx_engineers_name ON engineers(engineer_name);`,
    `CREATE INDEX IF NOT EXISTS idx_engineers_is_active ON engineers(is_active);`
];

async function run(): Promise<void> {
  const client = await pool.connect();

  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 017_engineers.sql");
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

