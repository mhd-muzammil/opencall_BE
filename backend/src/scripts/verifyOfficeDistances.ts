// Read-only sanity check for the Distance column: resolves a Flex WIP export's
// pincodes through the SAME code the importer and generator use, and prints the
// distance and direction each call would show.
//
// Exists because the directory's coordinate errors are large and silent — a
// wrong pincode centroid produces a confident, plausible-looking number. Running
// this against a real export before trusting the column is the cheapest way to
// catch that, and it needs no database.
//
// Usage:
//   npx tsx src/scripts/verifyOfficeDistances.ts <flex.xlsx> [--asp ASPS01461]
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import {
  readDirectoryCsv,
  resolvePincodeCoordinates,
} from "../services/geo/pincodeDirectory.js";
import { normalizePincode } from "../services/normalization/valueNormalizer.js";
import { officeDistance, type GeoPoint } from "../utils/geo.js";

const xlsx: typeof XLSX =
  typeof (XLSX as { read?: unknown }).read === "function"
    ? XLSX
    : (XLSX as unknown as { default: typeof XLSX }).default;

const DEFAULT_DIRECTORY = "data/ALL INDIA PINCODE.csv";

// Mirrors the seed in migration 043. Kept here so the check runs without a DB.
const OFFICES: Record<string, { label: string; point: GeoPoint }> = {
  ASPS01461: {
    label: "Chennai - Maduravoyal",
    point: { latitude: 13.054517, longitude: 80.177834 },
  },
};

function flagValue(name: string): string | null {
  const at = process.argv.indexOf(name);

  return at !== -1 ? (process.argv[at + 1] ?? null) : null;
}

function run(): void {
  const flexPath = process.argv[2];
  if (!flexPath || flexPath.startsWith("--")) {
    console.error("Usage: verifyOfficeDistances.ts <flex.xlsx> [--asp CODE] [--directory path.csv]");
    process.exitCode = 1;
    return;
  }

  const aspCode = (flagValue("--asp") ?? "ASPS01461").toUpperCase();
  const office = OFFICES[aspCode];
  if (!office) {
    console.error(`No office coordinate known for ${aspCode}.`);
    process.exitCode = 1;
    return;
  }

  const workbook = xlsx.read(readFileSync(flexPath), { type: "buffer" });
  const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets[workbook.SheetNames[0]!]!,
    { defval: null },
  );

  const callsByPincode = new Map<string, number>();
  let scoped = 0;

  for (const row of rows) {
    if (String(row["Work Location"] ?? "").trim().toUpperCase() !== aspCode) continue;
    scoped += 1;
    const pincode = normalizePincode(String(row["Customer Pincode"] ?? ""));
    if (pincode) callsByPincode.set(pincode, (callsByPincode.get(pincode) ?? 0) + 1);
  }

  const directory = readDirectoryCsv(
    readFileSync(flagValue("--directory") ?? DEFAULT_DIRECTORY, "utf8"),
  );
  const { resolved } = resolvePincodeCoordinates(directory);

  interface Line {
    pincode: string;
    calls: number;
    km: number | null;
    bearing: string;
    area: string;
    officesUsed: number;
  }

  const lines: Line[] = [];

  for (const [pincode, calls] of callsByPincode) {
    const centroid = resolved.get(pincode);
    const distance = officeDistance(office.point, centroid ?? null);
    lines.push({
      pincode,
      calls,
      km: distance?.distanceKm ?? null,
      bearing: distance?.bearing ?? "-",
      area: centroid?.areaName ?? "(unresolved)",
      officesUsed: centroid?.officesUsed ?? 0,
    });
  }

  lines.sort((a, b) => (a.km ?? Number.POSITIVE_INFINITY) - (b.km ?? Number.POSITIVE_INFINITY));

  console.log(`${office.label} — ${scoped} calls, ${lines.length} pincodes\n`);
  console.log("pin     calls  distance  dir   used  area");
  console.log("-".repeat(64));
  for (const line of lines) {
    const km = line.km == null ? "     -" : `${line.km.toFixed(1)} km`.padStart(9);
    console.log(
      `${line.pincode}  ${String(line.calls).padStart(4)}  ${km} ${line.bearing.padStart(5)}  ${String(line.officesUsed).padStart(4)}  ${line.area}`,
    );
  }

  const resolvedCalls = lines.filter((l) => l.km != null).reduce((s, l) => s + l.calls, 0);
  console.log(
    `\n${resolvedCalls}/${scoped} calls get a distance (${((resolvedCalls / scoped) * 100).toFixed(1)}%)`,
  );
}

run();
