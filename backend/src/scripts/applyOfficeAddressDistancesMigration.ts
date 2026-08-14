import { closeDatabasePool, pool } from "../config/database.js";

// Migration 055_office_address_distances.sql — routed road distance per
// (office, geocoded address), the exact-address tier's counterpart of
// office_pincode_distances. See the .sql file for the full rationale.
// Inlined because the deploy image does not ship the repo's infra/ directory.
const sqlQueries = [
  `CREATE TABLE IF NOT EXISTS office_address_distances (
     asp_code    TEXT NOT NULL,
     address_key TEXT NOT NULL REFERENCES geocode_cache(address_key) ON DELETE CASCADE,
     road_km     NUMERIC(7, 1) NOT NULL,
     provider    TEXT NOT NULL DEFAULT 'osrm',
     computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (asp_code, address_key),
     CONSTRAINT office_address_distances_positive CHECK (road_km >= 0)
   );`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 055_office_address_distances.sql");
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
