/**
 * READ-ONLY diagnostic. Cross-references every HP Stock inventory row against the
 * current RCV_SPARE parts in flex_wip_records and reports how many rows are
 * "phantom" (not a currently-received part), so you can see how the counts would
 * look if inventory were received-only. Writes NOTHING.
 *
 * Dual-mode, mirrors the sync:
 *   - INVENTORY_API_URL set  → reads inventory via the HTTP API (prod / live).
 *   - otherwise              → reads the local inventory SQLite (INVENTORY_DB_PATH).
 *
 *   npx tsx src/scripts/diagnoseInventoryReceived.ts
 */
import "../config/env.js";
import { pool, query as pgQuery } from "../config/database.js";
import { inventoryFetch } from "../services/inventorySyncService.js";
import { extractPartLine } from "../services/normalization/dedupeRowsByTicket.js";

const ACTIVE_EXCLUDED = new Set(["CLOSED", "DC_CUT_REQUEST"]);
const partKey = (good: string | null, order: string | null) =>
  `${(good ?? "").trim().toUpperCase()}|${(order ?? "").trim().toUpperCase()}`;

interface InvRow {
  case_id: string;
  good_part_number: string;
  part_order_number: string;
  status: string;
  region: string;
}

/** case_id -> set of "good|order" keys that are currently RCV_SPARE in flex. */
async function buildRcvSetByCase(): Promise<Map<string, Set<string>>> {
  const res = await pgQuery<{
    case_id: string | null;
    normalized_case_id: string | null;
    raw_row: Record<string, unknown>;
  }>(`SELECT case_id, normalized_case_id, raw_row FROM flex_wip_records`);

  const map = new Map<string, Set<string>>();
  for (const r of res.rows) {
    const part = extractPartLine({ rawRow: r.raw_row });
    if (part.goodPartInstalledStatus !== "RCV_SPARE") continue;
    const key = partKey(part.goodPartNo, part.partOrderNo);
    for (const cid of [r.case_id, r.normalized_case_id]) {
      if (!cid) continue;
      if (!map.has(cid)) map.set(cid, new Set());
      map.get(cid)!.add(key);
    }
  }
  return map;
}

async function fetchInventoryRows(): Promise<InvRow[]> {
  const rows: InvRow[] = [];
  if (process.env.INVENTORY_API_URL) {
    let page = 1;
    for (;;) {
      const res = await inventoryFetch(
        `/hp-stock/items/?per_page=100&page=${page}`,
        { method: "GET" },
      );
      if (!res.ok) throw new Error(`inventory list failed ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { items?: any[]; pages?: number };
      for (const it of data.items ?? []) {
        rows.push({
          case_id: String(it.case_id ?? ""),
          good_part_number: String(it.good_part_number ?? ""),
          part_order_number: String(it.part_order_number ?? ""),
          status: String(it.status ?? ""),
          region: String(it.region ?? ""),
        });
      }
      if (page >= (data.pages ?? 1)) break;
      page += 1;
    }
    return rows;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db: any = new DatabaseSync(process.env.INVENTORY_DB_PATH!);
  return db
    .prepare("SELECT case_id, good_part_number, part_order_number, status, region FROM hp_stock_hpstockitem")
    .all() as InvRow[];
}

async function main(): Promise<void> {
  const rcvByCase = await buildRcvSetByCase();
  const rows = await fetchInventoryRows();

  // Categories (from most to least confident that the row is NOT real stock):
  //   received        : row's (good|order) IS a current RCV_SPARE part.
  //   noRcvCase       : the case has ZERO RCV_SPARE parts → definitely no stock.
  //   mismatchLabeled : case has RCV parts, row has good/order but not a match
  //                     (stale/replaced part order) → confident phantom.
  //   ambiguousEmpty  : case has RCV parts but this row has blank good+order →
  //                     can't confidently classify (needs manual review).
  const cat = {
    received: 0,
    noRcvCase: 0,
    mismatchLabeled: 0,
    ambiguousEmpty: 0,
  };
  const untouched = { noRcvCase: 0, mismatchLabeled: 0, ambiguousEmpty: 0 };
  const activeByRegion = new Map<string, { all: number; received: number }>();
  const samples: Record<"noRcvCase" | "mismatchLabeled" | "ambiguousEmpty", InvRow[]> = {
    noRcvCase: [],
    mismatchLabeled: [],
    ambiguousEmpty: [],
  };

  for (const r of rows) {
    const rcv = rcvByCase.get(r.case_id);
    const caseHasRcv = (rcv?.size ?? 0) > 0;
    const rowMatches = rcv?.has(partKey(r.good_part_number, r.part_order_number)) ?? false;
    const labeled = Boolean(r.good_part_number.trim() || r.part_order_number.trim());

    let bucket: keyof typeof cat;
    if (rowMatches) bucket = "received";
    else if (!caseHasRcv) bucket = "noRcvCase";
    else if (labeled) bucket = "mismatchLabeled";
    else bucket = "ambiguousEmpty";
    cat[bucket] += 1;

    if (bucket !== "received") {
      if (r.status === "PENDING") untouched[bucket] += 1;
      if (samples[bucket].length < 8) samples[bucket].push(r);
    }

    if (!ACTIVE_EXCLUDED.has(r.status)) {
      const region = r.region || "(none)";
      const b = activeByRegion.get(region) ?? { all: 0, received: 0 };
      b.all += 1;
      if (rowMatches) b.received += 1;
      activeByRegion.set(region, b);
    }
  }

  const phantom = cat.noRcvCase + cat.mismatchLabeled;
  console.log("\n=== Inventory received-vs-phantom diagnostic (READ-ONLY) ===");
  console.log(`Total inventory rows:            ${rows.length}`);
  console.log(`  RCV_SPARE (real stock):        ${cat.received}`);
  console.log(`  Confident phantom:             ${phantom}`);
  console.log(`    - case has NO RCV part:      ${cat.noRcvCase}  (untouched: ${untouched.noRcvCase})`);
  console.log(`    - labeled part not received: ${cat.mismatchLabeled}  (untouched: ${untouched.mismatchLabeled})`);
  console.log(`  Ambiguous (blank good/order):  ${cat.ambiguousEmpty}  (untouched: ${untouched.ambiguousEmpty})  <- review, do not auto-delete`);

  console.log(`\nActive count per region  (current -> RCV_SPARE-only):`);
  let totAll = 0, totRcv = 0;
  for (const [region, b] of [...activeByRegion.entries()].sort()) {
    console.log(`  ${region.padEnd(14)} ${String(b.all).padStart(4)} -> ${b.received}`);
    totAll += b.all; totRcv += b.received;
  }
  console.log(`  ${"TOTAL".padEnd(14)} ${String(totAll).padStart(4)} -> ${totRcv}`);

  for (const key of ["noRcvCase", "mismatchLabeled", "ambiguousEmpty"] as const) {
    if (!samples[key].length) continue;
    console.log(`\nSample [${key}]:`);
    for (const r of samples[key]) {
      console.log(`  case=${r.case_id} good=${r.good_part_number || "-"} order=${r.part_order_number || "-"} status=${r.status} region=${r.region}`);
    }
  }

  await pool.end();
}

void main();
