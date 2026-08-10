// Load the pincode centroid table from the shipped seed file.
//
// WHY A SEED AND NOT THE IMPORTER
// -------------------------------
// `importPincodeGeo` derives these coordinates from the All India Pincode
// Directory — a 165k-row, ~20MB CSV that does not belong in git, and which needs
// a non-trivial estimator to turn several post-office rows per pincode into one
// trustworthy coordinate. Running that on every environment would mean shipping
// the CSV everywhere and re-deriving the same answer each time.
//
// The seed is that estimator's verified output: 1,976 Tamil Nadu pincodes, with
// the directory's corrupt rows already rejected and any hand corrections
// preserved. Pincodes whose offices were ALL rejected are deliberately absent —
// their work orders resolve to no coordinate, which is honest, rather than to a
// fabricated one.
//
// The seed uses ON CONFLICT DO NOTHING, so a row corrected by hand on this box
// (source='manual') is never overwritten by a re-run.
//
// Reads from `data/` for the same reason importPincodeAreaMappings does: that
// directory ships inside the deploy image, where `infra/` does not.
//
//   npx tsx src/scripts/seedPincodeGeo.ts        (dev)
//   node dist/scripts/seedPincodeGeo.js          (prod)
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabasePool, pool } from "../config/database.js";

// Same depth from src/scripts and dist/scripts alike: both sit two levels below
// `backend`, so two up is the package root and `data/` sits beside them.
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SEED_FILE = path.join(packageRoot, "data", "pincode_geo_seed.sql");

async function run(): Promise<void> {
  const client = await pool.connect();

  try {
    const tableExists = await client.query<{ present: boolean }>(
      `SELECT COUNT(*) = 1 AS present
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'pincode_geo'`,
    );

    if (!tableExists.rows[0]?.present) {
      console.error(
        "pincode_geo does not exist. Run `npm run migrate:geocoding` (migration 045) first.",
      );
      process.exitCode = 1;
      return;
    }

    const before = await client.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM pincode_geo`,
    );

    let sql: string;
    try {
      sql = readFileSync(SEED_FILE, "utf8");
    } catch {
      console.error(
        `Seed file not found at ${SEED_FILE}.\n` +
          "It ships in backend/data/. If this is a deploy image, the file was not copied.",
      );
      process.exitCode = 1;
      return;
    }

    await client.query(sql);

    const after = await client.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM pincode_geo`,
    );
    const manual = await client.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM pincode_geo WHERE source = 'manual'`,
    );

    const inserted = Number(after.rows[0]?.count ?? 0) - Number(before.rows[0]?.count ?? 0);
    console.log(
      `Seeded pincode_geo: ${inserted} inserted, ` +
        `${after.rows[0]?.count ?? 0} total (${manual.rows[0]?.count ?? 0} hand-corrected, left untouched).`,
    );
  } catch (error) {
    console.error("Seeding failed:", error);
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
