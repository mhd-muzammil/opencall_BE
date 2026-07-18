/**
 * Inventory phantom cleanup, so the HP Stock counts reflect RCV_SPARE parts only.
 * DRY-RUN by default (writes nothing) — set APPLY=1 to make changes.
 *
 * Given the current RCV_SPARE parts in flex_wip_records, each inventory row is:
 *   received        : row (good|order) IS a current RCV_SPARE part.            KEEP
 *   ambiguousSole   : blank good/order, case HAS RCV part(s), NO labeled        KEEP
 *                     received row exists → this row IS the real unlabeled       (relabel if
 *                     stock. If the case has exactly ONE RCV part it is           single-part)
 *                     relabeled in place; multi-part sole rows are left for
 *                     review (can't tell which part they are).
 *   ambiguousDup    : blank good/order, case ALSO has a labeled received row     DELETE (untouched)
 *                     → stale duplicate.
 *   labeledMismatch : case has RCV parts, row labeled but not one of them        DELETE (untouched)
 *   flexNoRcv       : case in flex but ZERO RCV parts → no received stock        DELETE (untouched)
 *   noFlexData      : case not in flex at all → unverifiable                     KEEP (review)
 * Worked-on rows (status != PENDING) are NEVER auto-changed — reported instead.
 *
 *   npx tsx src/scripts/cleanupInventoryPhantoms.ts          # dry run
 *   APPLY=1 npx tsx src/scripts/cleanupInventoryPhantoms.ts  # apply
 */
import "../config/env.js";
import { pool, query as pgQuery } from "../config/database.js";
import { inventoryFetch } from "../services/inventorySyncService.js";
import { extractPartLine } from "../services/normalization/dedupeRowsByTicket.js";

const APPLY = process.env.APPLY === "1";
const partKey = (good: string | null, order: string | null) =>
  `${(good ?? "").trim().toUpperCase()}|${(order ?? "").trim().toUpperCase()}`;

interface Part { good: string; order: string }
interface InvRow {
  id: number | string;
  case_id: string;
  good_part_number: string;
  part_order_number: string;
  status: string;
  region: string;
}
type Category =
  | "received" | "ambiguousSole" | "ambiguousDup"
  | "labeledMismatch" | "flexNoRcv" | "noFlexData";

const DELETABLE: ReadonlySet<Category> = new Set(["ambiguousDup", "labeledMismatch", "flexNoRcv"]);

async function loadFlex(): Promise<{ rcvByCase: Map<string, Map<string, Part>>; flexCases: Set<string> }> {
  const res = await pgQuery<{ case_id: string | null; normalized_case_id: string | null; raw_row: Record<string, unknown> }>(
    `SELECT case_id, normalized_case_id, raw_row FROM flex_wip_records`,
  );
  const rcvByCase = new Map<string, Map<string, Part>>();
  const flexCases = new Set<string>();
  for (const r of res.rows) {
    const p = extractPartLine({ rawRow: r.raw_row });
    for (const cid of [r.case_id, r.normalized_case_id]) {
      if (!cid) continue;
      flexCases.add(cid);
      if (p.goodPartInstalledStatus === "RCV_SPARE") {
        if (!rcvByCase.has(cid)) rcvByCase.set(cid, new Map());
        rcvByCase.get(cid)!.set(partKey(p.goodPartNo, p.partOrderNo), {
          good: p.goodPartNo ?? "",
          order: p.partOrderNo ?? "",
        });
      }
    }
  }
  return { rcvByCase, flexCases };
}

async function fetchInventoryRows(): Promise<InvRow[]> {
  const rows: InvRow[] = [];
  if (process.env.INVENTORY_API_URL) {
    let page = 1;
    for (;;) {
      const res = await inventoryFetch(`/hp-stock/items/?per_page=100&page=${page}`, { method: "GET" });
      if (!res.ok) throw new Error(`inventory list failed ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { items?: any[]; pages?: number };
      for (const it of data.items ?? []) {
        rows.push({
          id: it.id,
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
    .prepare("SELECT id, case_id, good_part_number, part_order_number, status, region FROM hp_stock_hpstockitem")
    .all() as InvRow[];
}

async function deleteRow(id: InvRow["id"]): Promise<void> {
  if (process.env.INVENTORY_API_URL) {
    const res = await inventoryFetch(`/hp-stock/items/${id}/`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`delete ${id} failed ${res.status}: ${await res.text()}`);
    return;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db: any = new DatabaseSync(process.env.INVENTORY_DB_PATH!);
  db.prepare("DELETE FROM hp_stock_hpstockitem WHERE id = ?").run(id);
  db.close();
}

async function relabelRow(id: InvRow["id"], part: Part): Promise<void> {
  if (process.env.INVENTORY_API_URL) {
    const res = await inventoryFetch(`/hp-stock/items/${id}/`, {
      method: "PATCH",
      body: JSON.stringify({ good_part_number: part.good, part_order_number: part.order }),
    });
    if (!res.ok) throw new Error(`relabel ${id} failed ${res.status}: ${await res.text()}`);
    return;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db: any = new DatabaseSync(process.env.INVENTORY_DB_PATH!);
  db.prepare("UPDATE hp_stock_hpstockitem SET good_part_number = ?, part_order_number = ? WHERE id = ?")
    .run(part.good, part.order, id);
  db.close();
}

async function main(): Promise<void> {
  const { rcvByCase, flexCases } = await loadFlex();
  const rows = await fetchInventoryRows();

  const casesWithReceivedRow = new Set<string>();
  for (const r of rows) {
    if (rcvByCase.get(r.case_id)?.has(partKey(r.good_part_number, r.part_order_number))) {
      casesWithReceivedRow.add(r.case_id);
    }
  }

  const classify = (r: InvRow): Category => {
    const rcv = rcvByCase.get(r.case_id);
    if (rcv?.has(partKey(r.good_part_number, r.part_order_number))) return "received";
    const labeled = Boolean(r.good_part_number.trim() || r.part_order_number.trim());
    if (!rcv || rcv.size === 0) return flexCases.has(r.case_id) ? "flexNoRcv" : "noFlexData";
    if (labeled) return "labeledMismatch";
    return casesWithReceivedRow.has(r.case_id) ? "ambiguousDup" : "ambiguousSole";
  };

  const counts = {} as Record<Category, number>;
  const toDelete: InvRow[] = [];
  const toRelabel: Array<{ row: InvRow; part: Part }> = [];
  let soleMultiPartReview = 0;
  let workedOnDeletable = 0;
  const perRegion = new Map<string, { before: number; after: number }>();

  for (const r of rows) {
    const cat = classify(r);
    counts[cat] = (counts[cat] ?? 0) + 1;
    const untouched = r.status === "PENDING";

    let willDelete = false;
    if (DELETABLE.has(cat)) {
      if (untouched) { toDelete.push(r); willDelete = true; }
      else workedOnDeletable += 1;
    } else if (cat === "ambiguousSole" && untouched) {
      const rcv = rcvByCase.get(r.case_id)!;
      if (rcv.size === 1) toRelabel.push({ row: r, part: [...rcv.values()][0]! });
      else soleMultiPartReview += 1;
    }

    const region = r.region || "(none)";
    const b = perRegion.get(region) ?? { before: 0, after: 0 };
    b.before += 1;
    if (!willDelete) b.after += 1; // deletes reduce the count; relabels keep the row
    perRegion.set(region, b);
  }

  console.log(`\n=== Inventory phantom cleanup (${APPLY ? "APPLY" : "DRY RUN"}) ===`);
  console.log(`Total rows: ${rows.length}`);
  for (const cat of ["received", "ambiguousSole", "ambiguousDup", "labeledMismatch", "flexNoRcv", "noFlexData"] as Category[]) {
    const note = DELETABLE.has(cat) ? "[DELETE untouched]" : cat === "noFlexData" ? "[keep/review]" : "[keep]";
    console.log(`  ${cat.padEnd(16)} ${String(counts[cat] ?? 0).padStart(5)}  ${note}`);
  }
  console.log(`\nWill DELETE (untouched phantom/duplicate): ${toDelete.length}`);
  console.log(`Will RELABEL (single-part sole stock):     ${toRelabel.length}`);
  console.log(`Sole multi-part rows left for review:      ${soleMultiPartReview}`);
  console.log(`Deletable-but-worked-on (review, untouched only is acted on): ${workedOnDeletable}`);

  console.log(`\nRegion total (before -> after cleanup):`);
  let tb = 0, ta = 0;
  for (const [region, b] of [...perRegion.entries()].sort()) {
    console.log(`  ${region.padEnd(14)} ${String(b.before).padStart(5)} -> ${b.after}`);
    tb += b.before; ta += b.after;
  }
  console.log(`  ${"TOTAL".padEnd(14)} ${String(tb).padStart(5)} -> ${ta}`);

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing changed. Re-run with APPLY=1 to delete ${toDelete.length} and relabel ${toRelabel.length}.`);
    await pool.end();
    return;
  }

  let del = 0, rel = 0;
  for (const r of toDelete) {
    try { await deleteRow(r.id); del += 1; if (del % 50 === 0) console.log(`  deleted ${del}/${toDelete.length}`); }
    catch (e) { console.error(`  delete id=${r.id} failed:`, e instanceof Error ? e.message : e); }
  }
  for (const { row, part } of toRelabel) {
    try { await relabelRow(row.id, part); rel += 1; if (rel % 50 === 0) console.log(`  relabeled ${rel}/${toRelabel.length}`); }
    catch (e) { console.error(`  relabel id=${row.id} failed:`, e instanceof Error ? e.message : e); }
  }
  console.log(`\nDone. Deleted ${del}/${toDelete.length}, relabeled ${rel}/${toRelabel.length}. Inventory is now received-only.`);
  await pool.end();
}

void main();
