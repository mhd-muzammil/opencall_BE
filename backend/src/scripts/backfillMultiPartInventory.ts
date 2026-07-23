/**
 * One-time backfill for the multi-part inventory sync.
 *
 * Until the per-part sync landed, a case that ordered several parts was
 * collapsed to a SINGLE HP Stock item (the old sync took `LIMIT 1` on the Flex
 * part rows). This script finds OPEN inventory cases whose Flex data has more
 * parts than the case has inventory items, and adds the missing part items — it
 * NEVER deletes, and it never touches a part that already has an item (matched
 * on Part Order No / Good Part No), so an existing item keeps its workflow
 * status, photos and history.
 *
 * SAFE BY DEFAULT: a dry run that only REPORTS the delta. Pass --apply to write.
 * Dual-mode, mirrors the sync:
 *   - INVENTORY_API_URL set → reads/writes inventory via the HTTP API (prod).
 *   - otherwise             → reads/writes the local inventory SQLite.
 *
 * Usage:
 *   npx tsx src/scripts/backfillMultiPartInventory.ts                 # dry run, all open cases
 *   npx tsx src/scripts/backfillMultiPartInventory.ts --case=5162198038   # one case
 *   npx tsx src/scripts/backfillMultiPartInventory.ts --region=chennai    # one region
 *   npx tsx src/scripts/backfillMultiPartInventory.ts --limit=50          # cap cases
 *   npx tsx src/scripts/backfillMultiPartInventory.ts --apply             # WRITE the missing items
 */
import "../config/env.js";
import { closeDatabasePool, query as pgQuery } from "../config/database.js";
import {
  fetchCaseParts,
  inventoryFetch,
  itemMatchesPart,
  syncPartToInventory,
  type CasePartNumbers,
} from "../services/inventorySyncService.js";

const OPEN_EXCLUDED = new Set(["CLOSED", "DC_CUT_REQUEST"]);

interface InventoryItem {
  case_id: string;
  good_part_number: string;
  part_order_number: string;
  status: string;
  region: string;
}

interface Args {
  apply: boolean;
  caseId: string | null;
  region: string | null;
  limit: number | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, caseId: null, region: null, limit: null };
  for (const a of argv) {
    if (a === "--apply") args.apply = true;
    else if (a.startsWith("--case=")) args.caseId = a.slice("--case=".length).trim();
    else if (a.startsWith("--region=")) args.region = a.slice("--region=".length).trim().toLowerCase();
    else if (a.startsWith("--limit=")) {
      const n = parseInt(a.slice("--limit=".length), 10);
      if (Number.isFinite(n) && n > 0) args.limit = n;
    }
  }
  return args;
}

/** Every OPEN inventory item, keyed by case_id (dual-mode read). */
async function fetchOpenItemsByCase(): Promise<Map<string, InventoryItem[]>> {
  const items: InventoryItem[] = [];
  if (process.env.INVENTORY_API_URL) {
    let page = 1;
    for (;;) {
      const res = await inventoryFetch(
        `/hp-stock/items/?per_page=100&page=${page}`,
        { method: "GET" },
      );
      if (!res.ok) {
        throw new Error(`inventory list failed ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as { items?: any[]; pages?: number };
      for (const it of data.items ?? []) {
        items.push({
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
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    const dbPath =
      process.env.INVENTORY_DB_PATH ||
      "c:/Users/mohamed vaseem/Documents/company ptoject/inventry-web/inventory_backend/db.sqlite3";
    const db: any = new DatabaseSync(dbPath);
    try {
      const rows = db
        .prepare(
          "SELECT case_id, good_part_number, part_order_number, status, region FROM hp_stock_hpstockitem",
        )
        .all() as InventoryItem[];
      items.push(...rows);
    } finally {
      db.close();
    }
  }

  const byCase = new Map<string, InventoryItem[]>();
  for (const it of items) {
    if (!it.case_id || OPEN_EXCLUDED.has(it.status)) continue;
    const list = byCase.get(it.case_id) ?? [];
    list.push(it);
    byCase.set(it.case_id, list);
  }
  return byCase;
}

/** Latest report row for a case — the SyncRowInput fields the sync needs. */
async function latestReportRow(caseId: string): Promise<{
  ticket_id: string;
  part: string | null;
  work_location: string | null;
  engineer: string | null;
  customer_name: string | null;
} | null> {
  const res = await pgQuery<{
    ticket_id: string | null;
    part: string | null;
    work_location: string | null;
    engineer: string | null;
    customer_name: string | null;
  }>(
    `
      SELECT ticket_id, part, work_location, engineer, customer_name
      FROM daily_call_plan_report_rows
      WHERE case_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [caseId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    ticket_id: r.ticket_id ?? "",
    part: r.part,
    work_location: r.work_location,
    engineer: r.engineer,
    customer_name: r.customer_name,
  };
}

function partLabel(p: CasePartNumbers): string {
  return p.partOrderNumber || p.goodPartNumber || "(no number)";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log("=== backfillMultiPartInventory ===");
  console.log(
    `mode: ${args.apply ? "APPLY (writing)" : "DRY RUN (no writes)"}` +
      `${args.caseId ? ` | case=${args.caseId}` : ""}` +
      `${args.region ? ` | region=${args.region}` : ""}` +
      `${args.limit ? ` | limit=${args.limit}` : ""}`,
  );

  const openByCase = await fetchOpenItemsByCase();
  let caseIds = [...openByCase.keys()];
  if (args.caseId) caseIds = caseIds.filter((c) => c === args.caseId);
  if (args.region) {
    caseIds = caseIds.filter((c) =>
      (openByCase.get(c) ?? []).some((it) => it.region === args.region),
    );
  }
  caseIds.sort();

  const plan: Array<{
    caseId: string;
    region: string;
    itemCount: number;
    partCount: number;
    missing: CasePartNumbers[];
  }> = [];

  for (const caseId of caseIds) {
    const items = openByCase.get(caseId) ?? [];
    const parts = await fetchCaseParts(caseId);
    const missing = parts.filter(
      (p) => !items.some((it) => itemMatchesPart(it, p)),
    );
    if (missing.length > 0) {
      plan.push({
        caseId,
        region: items[0]?.region ?? "",
        itemCount: items.length,
        partCount: parts.length,
        missing,
      });
    }
  }

  plan.sort((a, b) => b.missing.length - a.missing.length);
  const capped = args.limit ? plan.slice(0, args.limit) : plan;

  console.log(
    `\nOpen cases scanned: ${caseIds.length} | cases missing part items: ${plan.length}` +
      `${args.limit ? ` | processing first ${capped.length}` : ""}`,
  );
  const totalMissing = capped.reduce((s, p) => s + p.missing.length, 0);
  console.log(`Total missing part items to add: ${totalMissing}\n`);

  console.log("--- Cases with missing part items (top 40 shown) ---");
  for (const p of capped.slice(0, 40)) {
    console.log(
      `  ${p.caseId} [${p.region}] items=${p.itemCount} parts=${p.partCount} ` +
        `-> add ${p.missing.length}: ${p.missing.map(partLabel).join(", ")}`,
    );
  }
  if (capped.length > 40) console.log(`  … and ${capped.length - 40} more`);

  if (!args.apply) {
    console.log(
      "\nDRY RUN — nothing written. Re-run with --apply to add the missing part items.",
    );
    return;
  }

  console.log("\nAPPLYING — adding missing part items via the per-part sync…");
  let done = 0;
  let skipped = 0;
  for (const p of capped) {
    const row = await latestReportRow(p.caseId);
    if (!row || !row.part) {
      skipped += 1;
      console.warn(`  SKIP ${p.caseId} — no report row with a part to sync from`);
      continue;
    }
    // The per-part sync creates the missing items and refreshes the existing
    // ones; it never deletes and never changes an item's workflow status.
    await syncPartToInventory({
      case_id: p.caseId,
      ticket_id: row.ticket_id,
      part: row.part,
      work_location: row.work_location,
      engineer: row.engineer,
      customer_name: row.customer_name,
    });
    done += 1;
    if (done % 25 === 0) console.log(`  …synced ${done}/${capped.length} cases`);
  }
  console.log(
    `\nDONE — synced ${done} case(s), skipped ${skipped}. ` +
      `Re-run without --apply to confirm the delta is now zero.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabasePool();
  });
