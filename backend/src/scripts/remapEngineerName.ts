/**
 * One-off remap of an engineer's NAME string on historical call/report rows.
 *
 * Why: call/report rows store the engineer as a NAME string, not an id. When
 * an engineer is renamed (e.g. Chennai's "Jeeva" -> "Jeeva CH"), rows written
 * before the rename still carry the old name, so filters and reports treat
 * them as two different engineers. The admin update endpoint now remaps
 * history automatically; this script backfills renames that happened BEFORE
 * that fix shipped.
 *
 * What it touches (region-scoped, case-insensitive on the old name):
 *   - daily_call_plan_report_rows.engineer  (row's work_location ASP code in
 *     the region, OR the parent report region-scoped to it)
 *   - call_plan_records.engineer            (upload batch region-scoped to it;
 *     region-less batches are never touched — their region is unknowable)
 *   - engineers.engineer_name               (records in the region still
 *     carrying the old name — normally none, the admin already renamed)
 * Rows already carrying the NEW name in a different casing are normalised
 * onto the exact new spelling, so the remap can never split one engineer into
 * two casing buckets. raw_row JSONB (verbatim upload payloads), the audit
 * trail and frozen EOD productivity snapshots are deliberately left alone
 * (snapshot hits are reported; reopen + re-close a day to refresh one).
 *
 * ABORTS if the region has BOTH an old-name and a new-name engineer record —
 * that is two distinct people, and remapping would merge their case history.
 *
 * SAFE BY DEFAULT: dry run — executes the updates in a transaction, prints
 * per-table row counts, then ROLLS BACK. Pass --apply to commit.
 *
 * Usage (local, from backend/):
 *   npx tsx src/scripts/remapEngineerName.ts --old="Jeeva" --new="Jeeva CH" --region=chennai
 *   npx tsx src/scripts/remapEngineerName.ts --old="Jeeva" --new="Jeeva CH" --region=chennai --apply
 *
 * Prod (no pnpm; compiled output, deployed via Dokploy):
 *   node dist/scripts/remapEngineerName.js --old="Jeeva" --new="Jeeva CH" --region=chennai
 *   node dist/scripts/remapEngineerName.js --old="Jeeva" --new="Jeeva CH" --region=chennai --apply
 *
 * --region accepts the region name or code, case-insensitive ("chennai",
 * "Chennai", or the region's code) — or the region's UUID, for databases
 * where duplicate region records make a name ambiguous. An ambiguous name
 * lists every match (id, code, name, active) so you can rerun with the id.
 */
import "../config/env.js";
import { closeDatabasePool, pool } from "../config/database.js";
import { renameEngineerInHistoricalRows } from "../repositories/engineerRepository.js";
import { aspCodesForRegionIdentity } from "@opencall/shared";

interface Args {
  oldName: string | null;
  newName: string | null;
  region: string | null;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { oldName: null, newName: null, region: null, apply: false };
  for (const a of argv) {
    if (a === "--apply") args.apply = true;
    else if (a.startsWith("--old=")) args.oldName = a.slice("--old=".length).trim();
    else if (a.startsWith("--new=")) args.newName = a.slice("--new=".length).trim();
    else if (a.startsWith("--region=")) args.region = a.slice("--region=".length).trim();
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.oldName || !args.newName || !args.region) {
    console.error(
      'Usage: remapEngineerName --old="Old Name" --new="New Name" --region=<name|code> [--apply]',
    );
    process.exitCode = 1;
    return;
  }

  console.log("=== remapEngineerName ===");
  console.log(
    `mode: ${args.apply ? "APPLY (writing)" : "DRY RUN (transaction rolled back)"} | ` +
      `"${args.oldName}" -> "${args.newName}" | region=${args.region}`,
  );

  // --- Resolve the region (by UUID, or by name/code case-insensitive). ---
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.region);
  const regionResult = await pool.query<{
    id: string;
    code: string;
    name: string;
    is_active: boolean;
  }>(
    isUuid
      ? `SELECT id, code, name, is_active FROM regions WHERE id = $1`
      : `
          SELECT id, code, name, is_active
          FROM regions
          WHERE lower(trim(name)) = lower(trim($1)) OR lower(trim(code)) = lower(trim($1))
        `,
    [args.region],
  );
  if (regionResult.rows.length !== 1) {
    if (regionResult.rows.length === 0) {
      console.error(`Region "${args.region}" not found.`);
    } else {
      console.error(
        `Region "${args.region}" is ambiguous (${regionResult.rows.length} matches). ` +
          `Rerun with --region=<id> of the intended region:`,
      );
      for (const r of regionResult.rows) {
        console.error(
          `  --region=${r.id}  (code=${r.code}, name=${r.name}, active=${r.is_active})`,
        );
      }
    }
    process.exitCode = 1;
    return;
  }
  const region = regionResult.rows[0]!;
  const aspCodes = [...aspCodesForRegionIdentity(region.code, region.name)];
  console.log(
    `region: ${region.name} (${region.code}, ${region.id}) | ASP codes: ${aspCodes.join(", ") || "(none)"}`,
  );

  // --- Engineer records sanity check. ---
  const engineerRecords = await pool.query<{ id: string; engineer_name: string; is_active: boolean }>(
    `
      SELECT id, engineer_name, is_active
      FROM engineers
      WHERE region_id = $1
        AND lower(trim(engineer_name)) IN (lower(trim($2)), lower(trim($3)))
      ORDER BY engineer_name
    `,
    [region.id, args.oldName, args.newName],
  );
  const oldRecords = engineerRecords.rows.filter(
    (r) => r.engineer_name.trim().toLowerCase() === args.oldName!.toLowerCase(),
  );
  const newRecords = engineerRecords.rows.filter(
    (r) => r.engineer_name.trim().toLowerCase() === args.newName!.toLowerCase(),
  );
  console.log(
    `engineer records in region: old-name=${oldRecords.length}, new-name=${newRecords.length}`,
  );
  if (oldRecords.length > 0 && newRecords.length > 0) {
    console.error(
      `ABORT: region has BOTH an engineer named "${args.oldName}" and one named "${args.newName}" — ` +
        `two distinct people; remapping would merge their case history. Resolve the duplicate first.`,
    );
    process.exitCode = 1;
    return;
  }

  // --- Informational: frozen EOD snapshots carrying the old name (untouched). ---
  const snapshots = await pool.query<{ working_date: string }>(
    `
      SELECT working_date::TEXT AS working_date
      FROM region_productivity_snapshot s
      WHERE s.region_id = $1
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(s.payload->'list') AS e
          WHERE lower(trim(e->>'name')) = lower(trim($2))
        )
      ORDER BY working_date
    `,
    [region.id, args.oldName],
  );
  if (snapshots.rows.length > 0) {
    console.log(
      `note: ${snapshots.rows.length} frozen EOD productivity snapshot(s) still carry "${args.oldName}" ` +
        `(${snapshots.rows.map((r) => r.working_date).join(", ")}). Snapshots are frozen history and are ` +
        `NOT rewritten — reopen + re-close a day to refresh it.`,
    );
  }

  // --- The remap itself: run the real updates, count, commit or roll back. ---
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const counts = await renameEngineerInHistoricalRows(
      client,
      args.oldName,
      args.newName,
      { regionId: region.id, aspCodes },
    );

    const engineersResult = await client.query(
      `
        UPDATE engineers
        SET engineer_name = $2, updated_at = NOW()
        WHERE region_id = $3
          AND lower(trim(engineer_name)) = lower(trim($1))
          AND engineer_name IS DISTINCT FROM $2
      `,
      [args.oldName, args.newName, region.id],
    );

    console.log("\n--- Rows remapped (per table) ---");
    console.log(`  daily_call_plan_report_rows: ${counts.reportRows}`);
    console.log(`  call_plan_records:           ${counts.callPlanRecords}`);
    console.log(`  engineers:                   ${engineersResult.rowCount ?? 0}`);

    if (args.apply) {
      await client.query("COMMIT");
      console.log("\nAPPLIED — changes committed.");
    } else {
      await client.query("ROLLBACK");
      console.log("\nDRY RUN — transaction rolled back, nothing written. Re-run with --apply to commit.");
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabasePool();
  });
