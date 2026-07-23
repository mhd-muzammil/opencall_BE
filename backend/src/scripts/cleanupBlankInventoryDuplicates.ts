/**
 * One-time cleanup for the blank part-items the first multi-part backfill run
 * could create. That run treated a part whose Flex export carried NO numbers
 * (an "unkeyed" part) as missing, and added a blank HP Stock item next to the
 * case's real item. Those blanks are harmless to the value bands (a blank part
 * number matches no price) but are stray PENDING rows that should not exist.
 *
 * This removes a blank item ONLY when it is safe to:
 *   - all of good_part_number / part_order_number / so_number are blank, AND
 *   - status is PENDING (workflow never started), AND
 *   - transition_history is empty (no engineer action / photos), AND
 *   - the case still keeps at least one item afterwards (a non-blank item, or —
 *     when the case has only blanks — the oldest blank is kept).
 * It NEVER deletes a worked item and NEVER empties a case.
 *
 * SAFE BY DEFAULT: a dry run that only REPORTS. Pass --apply to delete.
 * Dual-mode (INVENTORY_API_URL → HTTP API; else local SQLite), mirrors the sync.
 *
 *   npx tsx src/scripts/cleanupBlankInventoryDuplicates.ts            # dry run
 *   npx tsx src/scripts/cleanupBlankInventoryDuplicates.ts --apply    # delete
 */
import "../config/env.js";
import { closeDatabasePool } from "../config/database.js";
import { inventoryFetch } from "../services/inventorySyncService.js";

interface Item {
  id: number | string;
  case_id: string;
  good_part_number: string;
  part_order_number: string;
  so_number: string;
  status: string;
  region: string;
  transition_len: number;
  created_at: string;
}

const apply = process.argv.slice(2).includes("--apply");

function isBlank(it: Item): boolean {
  return (
    !it.good_part_number.trim() &&
    !it.part_order_number.trim() &&
    !it.so_number.trim()
  );
}

/** A blank item that no one has touched — safe to consider for removal. */
function isUntouchedBlank(it: Item): boolean {
  return isBlank(it) && it.status === "PENDING" && it.transition_len === 0;
}

function transitionLen(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v || "[]");
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

async function fetchAllItems(): Promise<Item[]> {
  const items: Item[] = [];
  if (process.env.INVENTORY_API_URL) {
    let page = 1;
    for (;;) {
      const res = await inventoryFetch(
        `/hp-stock/items/?per_page=100&page=${page}`,
        { method: "GET" },
      );
      if (!res.ok) throw new Error(`list failed ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { items?: any[]; pages?: number };
      for (const it of data.items ?? []) {
        items.push({
          id: it.id,
          case_id: String(it.case_id ?? ""),
          good_part_number: String(it.good_part_number ?? ""),
          part_order_number: String(it.part_order_number ?? ""),
          so_number: String(it.so_number ?? ""),
          status: String(it.status ?? ""),
          region: String(it.region ?? ""),
          transition_len: transitionLen(it.transition_history),
          created_at: String(it.created_at ?? ""),
        });
      }
      if (page >= (data.pages ?? 1)) break;
      page += 1;
    }
    return items;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath =
    process.env.INVENTORY_DB_PATH ||
    "c:/Users/mohamed vaseem/Documents/company ptoject/inventry-web/inventory_backend/db.sqlite3";
  const db: any = new DatabaseSync(dbPath);
  try {
    const rows = db
      .prepare(
        "SELECT id, case_id, good_part_number, part_order_number, so_number, status, region, transition_history, created_at FROM hp_stock_hpstockitem",
      )
      .all() as any[];
    for (const r of rows) {
      items.push({
        id: r.id,
        case_id: String(r.case_id ?? ""),
        good_part_number: String(r.good_part_number ?? ""),
        part_order_number: String(r.part_order_number ?? ""),
        so_number: String(r.so_number ?? ""),
        status: String(r.status ?? ""),
        region: String(r.region ?? ""),
        transition_len: transitionLen(r.transition_history),
        created_at: String(r.created_at ?? ""),
      });
    }
  } finally {
    db.close();
  }
  return items;
}

async function deleteItem(id: number | string): Promise<void> {
  if (process.env.INVENTORY_API_URL) {
    const res = await inventoryFetch(`/hp-stock/items/${id}/`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      throw new Error(`delete ${id} failed ${res.status}: ${await res.text()}`);
    }
    return;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath =
    process.env.INVENTORY_DB_PATH ||
    "c:/Users/mohamed vaseem/Documents/company ptoject/inventry-web/inventory_backend/db.sqlite3";
  const db: any = new DatabaseSync(dbPath);
  try {
    db.prepare("DELETE FROM hp_stock_hpstockitem WHERE id = ?").run(id);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  console.log("=== cleanupBlankInventoryDuplicates ===");
  console.log(`mode: ${apply ? "APPLY (deleting)" : "DRY RUN (no deletes)"}`);

  const all = await fetchAllItems();
  const byCase = new Map<string, Item[]>();
  for (const it of all) {
    if (!it.case_id) continue;
    const list = byCase.get(it.case_id) ?? [];
    list.push(it);
    byCase.set(it.case_id, list);
  }

  const toDelete: Item[] = [];
  for (const items of byCase.values()) {
    const removableBlanks = items.filter(isUntouchedBlank);
    if (removableBlanks.length === 0) continue;
    const hasNonBlank = items.some((it) => !isBlank(it));
    if (hasNonBlank) {
      // Every untouched blank is a duplicate of a real item → remove all.
      toDelete.push(...removableBlanks);
    } else {
      // Case has only blanks → keep the oldest one, remove the rest.
      const sorted = [...removableBlanks].sort((a, b) =>
        a.created_at.localeCompare(b.created_at),
      );
      toDelete.push(...sorted.slice(1));
    }
  }

  console.log(
    `\nInventory items scanned: ${all.length} | cases: ${byCase.size}`,
  );
  console.log(`Blank duplicate items to remove: ${toDelete.length}\n`);

  console.log("--- Items to remove (top 60 shown) ---");
  for (const it of toDelete.slice(0, 60)) {
    console.log(`  id=${it.id} case=${it.case_id} [${it.region}] status=${it.status}`);
  }
  if (toDelete.length > 60) console.log(`  … and ${toDelete.length - 60} more`);

  if (!apply) {
    console.log("\nDRY RUN — nothing deleted. Re-run with --apply to remove them.");
    return;
  }

  console.log("\nAPPLYING — deleting blank duplicate items…");
  let done = 0;
  for (const it of toDelete) {
    await deleteItem(it.id);
    done += 1;
    if (done % 25 === 0) console.log(`  …deleted ${done}/${toDelete.length}`);
  }
  console.log(`\nDONE — deleted ${done} blank item(s). Re-run without --apply to confirm 0.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabasePool();
  });
