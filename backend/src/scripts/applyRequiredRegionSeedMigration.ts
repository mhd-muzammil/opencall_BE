import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabasePool, pool } from "../config/database.js";

const apiSrcDir = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(
  apiSrcDir,
  "../../../infra/postgres/migrations/015_required_region_seed.sql",
);

async function run(): Promise<void> {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("Applied migration 015_required_region_seed.sql");
  } catch (error) {
    await client.query("ROLLBACK");
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
