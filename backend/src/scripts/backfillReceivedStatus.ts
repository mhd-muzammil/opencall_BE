/**
 * Backfill `part_received_status` on existing HP Stock rows, and report what the
 * received-spare filter would hide before anyone turns it on.
 *
 * DRY RUN by default - writes nothing. Set APPLY=1 to patch.
 *
 * Run this BEFORE flipping the switch in HP Stock settings. The live sync only
 * refreshes cases that still appear in the daily report, so rows whose cases have
 * left the Flex export would otherwise sit at "unknown" forever. The pre-flight
 * table at the end is the number that actually matters: if a region is about to
 * lose far more rows than the receiving desk expects, the problem is Flex data
 * entry, and turning the filter on would only hide the evidence.
 *
 * Dual-mode, mirroring the sync:
 *   - INVENTORY_API_URL set  -> reads/writes inventory over the HTTP API (prod).
 *   - otherwise              -> reads/writes the local SQLite (INVENTORY_DB_PATH).
 *
 *   npx tsx src/scripts/backfillReceivedStatus.ts           # dry run + pre-flight
 *   APPLY=1 npx tsx src/scripts/backfillReceivedStatus.ts   # write
 */
import "../config/env.js";
import { closeDatabasePool, query as pgQuery } from "../config/database.js";
import {
  FLEX_RECEIVED,
  inventoryApiConfigured,
  inventoryFetch,
} from "../services/inventorySyncService.js";
import { extractPartLine } from "../services/normalization/dedupeRowsByTicket.js";

const APPLY = process.env.APPLY === "1";
const RECEIVED = "RECEIVED";
const IN_TRANSIT = "IN_TRANSIT";

interface InvRow {
  id: number;
  case_id: string;
  good_part_number: string;
  part_order_number: string;
  status: string;
  region: string;
  part_received_status: string;
}

interface CaseParts {
  byOrder: Map<string, string>;
  byGood: Map<string, string>;
  all: string[];
}

const norm = (value: string | null | undefined) =>
  (value ?? "").trim().toUpperCase();

/**
 * case_id -> its part lines from the NEWEST batch that carries the case, keyed
 * the way the sync matches them. DENSE_RANK (not ROW_NUMBER) so every line of
 * that batch survives, not just the first.
 */
async function loadFlexParts(): Promise<Map<string, CaseParts>> {
  const res = await pgQuery<{
    case_id: string | null;
    normalized_case_id: string | null;
    raw_row: Record<string, unknown>;
  }>(`
    WITH ranked AS (
      SELECT
        fw.case_id,
        fw.normalized_case_id,
        fw.raw_row,
        DENSE_RANK() OVER (
          PARTITION BY COALESCE(NULLIF(fw.case_id, ''), fw.normalized_case_id)
          ORDER BY b.created_at DESC, fw.upload_batch_id DESC
        ) AS batch_rank
      FROM flex_wip_records fw
      JOIN source_upload_batches b ON b.id = fw.upload_batch_id
    )
    SELECT case_id, normalized_case_id, raw_row
    FROM ranked
    WHERE batch_rank = 1
  `);

  const byCase = new Map<string, CaseParts>();
  for (const row of res.rows) {
    const line = extractPartLine({ rawRow: row.raw_row });
    const status = norm(line.goodPartInstalledStatus);
    if (!status) continue;

    for (const caseId of [row.case_id, row.normalized_case_id]) {
      if (!caseId) continue;
      let entry = byCase.get(caseId);
      if (!entry) {
        entry = { byOrder: new Map(), byGood: new Map(), all: [] };
        byCase.set(caseId, entry);
      }
      const order = norm(line.partOrderNo);
      const good = norm(line.goodPartNo);
      // Received wins wherever a key is claimed twice - a landed spare must not
      // be demoted by a stale duplicate line.
      const better = (existing: string | undefined) =>
        existing === FLEX_RECEIVED ? existing : status;
      if (order) entry.byOrder.set(order, better(entry.byOrder.get(order)));
      if (good) entry.byGood.set(good, better(entry.byGood.get(good)));
      entry.all.push(status);
    }
  }
  return byCase;
}

/** The Flex status for one inventory row, or null when it cannot be matched. */
function flexStatusFor(row: InvRow, parts: CaseParts | undefined): string | null {
  if (!parts) return null;
  const order = norm(row.part_order_number);
  if (order) return parts.byOrder.get(order) ?? null;
  const good = norm(row.good_part_number);
  if (good) return parts.byGood.get(good) ?? null;
  // No numbers at all: only safe when the case has exactly one part line.
  return parts.all.length === 1 ? parts.all[0]! : null;
}

async function fetchInventoryRows(): Promise<InvRow[]> {
  const rows: InvRow[] = [];
  if (inventoryApiConfigured()) {
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
      for (const item of data.items ?? []) {
        rows.push({
          id: Number(item.id),
          case_id: String(item.case_id ?? ""),
          good_part_number: String(item.good_part_number ?? ""),
          part_order_number: String(item.part_order_number ?? ""),
          status: String(item.status ?? ""),
          region: String(item.region ?? ""),
          part_received_status: String(item.part_received_status ?? ""),
        });
      }
      if (page >= (data.pages ?? 1)) break;
      page += 1;
    }
    return rows;
  }

  const { DatabaseSync } = await import("node:sqlite");
  const db: any = new DatabaseSync(process.env.INVENTORY_DB_PATH!);
  try {
    return db
      .prepare(
        `SELECT id, case_id, good_part_number, part_order_number, status, region,
                part_received_status
         FROM hp_stock_hpstockitem`,
      )
      .all() as InvRow[];
  } finally {
    db.close();
  }
}

async function writeRow(row: InvRow, next: string, flexRaw: string): Promise<void> {
  if (inventoryApiConfigured()) {
    const res = await inventoryFetch(`/hp-stock/items/${row.id}/`, {
      method: "PATCH",
      body: JSON.stringify({
        part_received_status: next,
        flex_installed_status: flexRaw,
      }),
    });
    if (!res.ok) {
      throw new Error(`patch ${row.id} failed ${res.status}: ${await res.text()}`);
    }
    return;
  }

  const { DatabaseSync } = await import("node:sqlite");
  const db: any = new DatabaseSync(process.env.INVENTORY_DB_PATH!);
  try {
    db.prepare(
      `UPDATE hp_stock_hpstockitem
       SET part_received_status = CASE
             WHEN part_received_status = 'RECEIVED' THEN 'RECEIVED' ELSE ? END,
           flex_installed_status = ?
       WHERE id = ?`,
    ).run(next, flexRaw, row.id);
  } finally {
    db.close();
  }
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

async function main(): Promise<void> {
  const flexByCase = await loadFlexParts();
  const rows = await fetchInventoryRows();
  console.log(
    `[Backfill] inventory rows: ${rows.length}, cases with Flex part lines: ${flexByCase.size}`,
  );

  const pending: Array<{ row: InvRow; next: string; raw: string }> = [];
  let unmatched = 0;
  let alreadyCorrect = 0;

  for (const row of rows) {
    const raw = flexStatusFor(row, flexByCase.get(row.case_id));
    if (raw === null) {
      // Fail open: leave it unknown so the filter keeps showing it.
      unmatched += 1;
      continue;
    }
    const next = raw === FLEX_RECEIVED ? RECEIVED : IN_TRANSIT;
    // Sticky: never propose walking a received spare back.
    if (row.part_received_status === RECEIVED) {
      alreadyCorrect += 1;
      continue;
    }
    if (row.part_received_status === next) {
      alreadyCorrect += 1;
      continue;
    }
    pending.push({ row, next, raw });
  }

  const toReceived = pending.filter((p) => p.next === RECEIVED).length;
  console.log(
    `[Backfill] to update: ${pending.length} (-> received ${toReceived}, -> in transit ${pending.length - toReceived})`,
  );
  console.log(
    `[Backfill] already correct: ${alreadyCorrect}, no Flex match (left unknown): ${unmatched}`,
  );

  if (APPLY) {
    let done = 0;
    for (const { row, next, raw } of pending) {
      await writeRow(row, next, raw);
      done += 1;
      if (done % 100 === 0) console.log(`[Backfill] ...${done}/${pending.length}`);
    }
    console.log(`[Backfill] wrote ${done} rows.`);
    // Reflect the writes in the pre-flight below.
    for (const { row, next } of pending) row.part_received_status = next;
  } else {
    console.log("[Backfill] DRY RUN - nothing written. Re-run with APPLY=1.");
  }

  // --- Pre-flight: what the filter would hide -------------------------------
  // Mirrors inventory's four doors: hidden only if it is not received, not
  // unknown, and nobody has started work on it (status still PENDING).
  const hiddenByRegion = new Map<string, number>();
  const activeByRegion = new Map<string, number>();
  for (const row of rows) {
    if (row.status === "CLOSED" || row.status === "DC_CUT_REQUEST") continue;
    const region = row.region || "(no region)";
    activeByRegion.set(region, (activeByRegion.get(region) ?? 0) + 1);
    const visible =
      row.part_received_status === RECEIVED ||
      row.part_received_status === "" ||
      row.status !== "PENDING";
    if (!visible) hiddenByRegion.set(region, (hiddenByRegion.get(region) ?? 0) + 1);
  }

  console.log(
    `\n${pad("REGION", 16)}${pad("ACTIVE ROWS", 14)}${pad("WOULD HIDE", 12)}REMAINING`,
  );
  const regions = [...activeByRegion.keys()].sort();
  for (const region of regions) {
    const active = activeByRegion.get(region) ?? 0;
    const hidden = hiddenByRegion.get(region) ?? 0;
    console.log(
      `${pad(region, 16)}${pad(active, 14)}${pad(hidden, 12)}${active - hidden}`,
    );
  }
  const totalActive = [...activeByRegion.values()].reduce((a, b) => a + b, 0);
  const totalHidden = [...hiddenByRegion.values()].reduce((a, b) => a + b, 0);
  console.log(
    `${pad("TOTAL", 16)}${pad(totalActive, 14)}${pad(totalHidden, 12)}${totalActive - totalHidden}`,
  );
  console.log(
    "\nIf a region would lose far more than the receiving desk expects, the gap is\n" +
      "Flex data entry, not this filter - fix that first.",
  );
}

main()
  .catch((err) => {
    console.error("[Backfill] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabasePool();
  });
