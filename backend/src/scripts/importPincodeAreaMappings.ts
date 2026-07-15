// Loads pincode -> area-name mappings into pincode_area_mappings from an Excel
// file (default: the Tamil Nadu list shipped in backend/data). The Records
// "Location" column resolves through this table at report-generation time
// (mapLocation): with a mapping the area name is shown, without it the raw
// pincode falls through — so filling this table upgrades every FUTURE report;
// past days' saved rows keep whatever they stored.
//
// Idempotent upsert on the pincode: re-running with a newer file refreshes the
// names. Mappings are inserted globally (region_id NULL), which every region's
// lookup accepts.
//
// Usage:
//   npx tsx src/scripts/importPincodeAreaMappings.ts [path/to/file.xlsx]   (dev)
//   node dist/scripts/importPincodeAreaMappings.js [path/to/file.xlsx]    (prod)
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { closeDatabasePool, pool } from "../config/database.js";
import { normalizePincode } from "../services/normalization/valueNormalizer.js";

// xlsx is CJS; under ESM the callable API may sit on .default depending on the
// loader (tsx vs compiled node). Resolve whichever shape is live.
const xlsx: typeof XLSX =
  typeof (XLSX as { read?: unknown }).read === "function"
    ? XLSX
    : ((XLSX as unknown as { default: typeof XLSX }).default);

const DEFAULT_FILE = "data/Tamil_Nadu_Pincodes.xlsx";
const CHUNK_SIZE = 500;

function headerIndex(header: unknown[], candidates: string[]): number {
  return header.findIndex((cell) =>
    candidates.includes(String(cell ?? "").trim().toLowerCase()),
  );
}

async function run(): Promise<void> {
  const filePath = process.argv[2] ?? DEFAULT_FILE;
  const workbook = xlsx.read(readFileSync(filePath), { type: "buffer" });

  const mappings = new Map<string, string>();
  let skipped = 0;

  for (const sheetName of workbook.SheetNames) {
    const rows = xlsx.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName]!, {
      header: 1,
    });
    if (rows.length < 2) continue;

    const header = rows[0] ?? [];
    const pincodeCol = headerIndex(header, ["pincode", "pin code", "pin"]);
    const areaCol = headerIndex(header, ["area name", "areaname", "area", "location"]);
    if (pincodeCol === -1 || areaCol === -1) {
      console.warn(`Sheet "${sheetName}": no Pincode/Area Name columns — skipped`);
      continue;
    }

    for (const row of rows.slice(1)) {
      const pincode = normalizePincode(row[pincodeCol]);
      const areaName = String(row[areaCol] ?? "").trim();
      if (!pincode || !areaName) {
        skipped += 1;
        continue;
      }
      mappings.set(pincode, areaName);
    }
  }

  if (mappings.size === 0) {
    throw new Error(`No usable pincode mappings found in ${filePath}`);
  }

  const entries = Array.from(mappings.entries());
  const client = await pool.connect();
  try {
    for (let offset = 0; offset < entries.length; offset += CHUNK_SIZE) {
      const chunk = entries.slice(offset, offset + CHUNK_SIZE);
      const placeholders = chunk
        .map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`)
        .join(", ");
      await client.query(
        `
          INSERT INTO pincode_area_mappings (pincode, area_name)
          VALUES ${placeholders}
          ON CONFLICT (pincode) DO UPDATE SET area_name = EXCLUDED.area_name
        `,
        chunk.flat(),
      );
    }
  } finally {
    client.release();
  }

  const total = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM pincode_area_mappings`,
  );
  console.log(
    `Imported ${entries.length} pincode mappings from ${filePath}` +
      `${skipped > 0 ? ` (${skipped} row(s) skipped: missing pincode/area)` : ""}. ` +
      `Table now holds ${total.rows[0]?.count ?? "?"} mappings.`,
  );
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabasePool();
  });
