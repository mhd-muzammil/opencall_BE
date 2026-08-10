// Loads one coordinate per pincode into pincode_geo from the All India Pincode
// Directory CSV (data.gov.in). This is the DESTINATION half of the Records page
// Distance column; region_offices holds the origin.
//
// The directory carries a real minority of corrupt coordinates, so rows are not
// taken at face value — see services/geo/pincodeDirectory.ts for the estimator
// and the specific failures that motivated it.
//
// MANUAL ROWS ARE NEVER OVERWRITTEN. A pincode the directory cannot resolve is
// corrected by hand with source='manual'; if a re-import clobbered those, every
// correction would be silently lost on the next refresh and the table would
// quietly regress to being untrustworthy.
//
// Usage:
//   npx tsx src/scripts/importPincodeGeo.ts [path/to/ALL_INDIA_PINCODE.csv]  (dev)
//   node dist/scripts/importPincodeGeo.js [path/to/file.csv]                 (prod)
//   ... --state "TAMIL NADU"    restrict to one state
//   ... --dry-run               resolve and report, write nothing
import { readFileSync } from "node:fs";
import { closeDatabasePool, pool } from "../config/database.js";
import {
  readDirectoryCsv,
  resolvePincodeCoordinates,
  type ResolvedPincode,
} from "../services/geo/pincodeDirectory.js";

const DEFAULT_FILE = "data/ALL INDIA PINCODE.csv";
const CHUNK_SIZE = 500;

interface Args {
  filePath: string;
  stateFilter: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let filePath: string | null = null;
  let stateFilter: string | null = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--state") {
      stateFilter = argv[i + 1]?.trim().toUpperCase() ?? null;
      i += 1;
    } else if (!arg.startsWith("--") && filePath === null) {
      filePath = arg;
    }
  }

  return { filePath: filePath ?? DEFAULT_FILE, stateFilter, dryRun };
}

async function upsertChunk(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number | null }> },
  chunk: ResolvedPincode[],
): Promise<number> {
  const values: unknown[] = [];
  const tuples = chunk.map((row, i) => {
    const base = i * 9;
    values.push(
      row.pincode,
      row.latitude,
      row.longitude,
      row.areaName,
      row.district,
      row.stateName,
      row.officesUsed,
      row.officesTotal,
      Number(row.spreadKm.toFixed(2)),
    );

    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
  });

  // `source` is omitted so it takes its 'directory' default on insert and keeps
  // its existing value on update.
  //
  // WHERE pincode_geo.source <> 'manual' is the whole point of this statement: a
  // hand-corrected coordinate outranks anything the directory says about it.
  const result = await client.query(
    `INSERT INTO pincode_geo (
       pincode, latitude, longitude, area_name, district, state_name,
       offices_used, offices_total, spread_km
     )
     VALUES ${tuples.join(", ")}
     ON CONFLICT (pincode) DO UPDATE SET
       latitude      = EXCLUDED.latitude,
       longitude     = EXCLUDED.longitude,
       area_name     = EXCLUDED.area_name,
       district      = EXCLUDED.district,
       state_name    = EXCLUDED.state_name,
       offices_used  = EXCLUDED.offices_used,
       offices_total = EXCLUDED.offices_total,
       spread_km     = EXCLUDED.spread_km,
       updated_at    = NOW()
     WHERE pincode_geo.source <> 'manual'`,
    values,
  );

  return result.rowCount ?? 0;
}

async function run(): Promise<void> {
  const { filePath, stateFilter, dryRun } = parseArgs(process.argv.slice(2));

  console.log(`Reading ${filePath}`);
  const offices = readDirectoryCsv(readFileSync(filePath, "utf8"));
  console.log(`  ${offices.length.toLocaleString()} office rows`);

  // The prefix anchors are computed from whatever is passed in, so filtering by
  // state BEFORE resolving keeps each anchor inside one state's geography.
  const scoped = stateFilter
    ? offices.filter((o) => o.stateName.toUpperCase().includes(stateFilter))
    : offices;

  if (stateFilter) {
    console.log(`  ${scoped.length.toLocaleString()} rows in ${stateFilter}`);
  }

  const { resolved, rejected } = resolvePincodeCoordinates(scoped);
  const rows = [...resolved.values()];

  console.log(`\nResolved ${rows.length.toLocaleString()} pincodes`);
  console.log(`Rejected ${rejected.length.toLocaleString()} (need a manual coordinate)`);

  // Single-source pincodes had nothing to cross-check them, so a wrong
  // coordinate there survives. Surfacing the count makes the review job visible
  // instead of leaving it to be discovered by a dispatcher.
  const unguarded = rows.filter((r) => r.officesUsed <= 1).length;
  console.log(`  of those, ${unguarded.toLocaleString()} rest on a single office row`);

  if (rejected.length > 0) {
    console.log("\nRejected sample:");
    for (const row of rejected.slice(0, 15)) {
      console.log(`  ${row.pincode}  ${row.areaName || "(unnamed)"} — ${row.reason}`);
    }
    if (rejected.length > 15) console.log(`  ... and ${rejected.length - 15} more`);
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  const client = await pool.connect();
  let written = 0;

  try {
    await client.query("BEGIN");
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      written += await upsertChunk(client, rows.slice(i, i + CHUNK_SIZE));
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const skipped = rows.length - written;
  console.log(`\nWrote ${written.toLocaleString()} rows.`);
  if (skipped > 0) {
    console.log(`Left ${skipped.toLocaleString()} manually-corrected rows untouched.`);
  }
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
