import { closeDatabasePool, pool } from "../config/database.js";

// Migration 054_region_offices_seed.sql — the four branch offices 043 had to leave
// out because their coordinates had not been supplied yet (a guessed origin would
// silently mis-rank every call in that region). Seeding them is all it takes for
// the Distance column to appear for these regions.
// Inlined because the deploy image does not ship the repo's infra/ directory.
const sqlQueries = [
  // DO NOTHING, same as the Chennai seed: if a coordinate is ever corrected by
  // hand in the table, a re-run must not put the old value back.
  `INSERT INTO region_offices (asp_code, label, latitude, longitude)
   VALUES
     ('ASPS01463', 'Vellore',     12.968108, 79.150375),
     ('ASPS01465', 'Salem',       11.670312, 78.142258),
     ('ASPS01489', 'Kanchipuram', 12.818904, 79.695457),
     ('ASPS01511', 'Hosur',       12.724307, 77.825411)
   ON CONFLICT (asp_code) DO NOTHING;`,
];

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const query of sqlQueries) {
      await client.query(query);
    }
    console.log("Applied migration 054_region_offices_seed.sql");
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
