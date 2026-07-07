import { closeDatabasePool, query } from "../config/database.js";
import { syncPartToInventory } from "../services/inventorySyncService.js";

/**
 * One-time backfill: push every existing Opencall case that has a part into the
 * Inventory HP Stock system. Uses the same syncPartToInventory() the live flow
 * uses, so it honours whichever target is configured (HTTP API when
 * INVENTORY_API_URL is set, else the local SQLite fallback). Idempotent:
 * insert-or-update by case_id, so it is safe to run more than once.
 *
 * Run in the prod Opencall environment (env vars already set):
 *   pnpm build && node dist/scripts/backfillHpStockSync.js
 *   (or: pnpm --filter @opencall/api hp-stock:backfill)
 */
async function main(): Promise<void> {
  const { rows } = await query<{
    case_id: string;
    ticket_id: string;
    part: string;
    work_location: string | null;
    engineer: string | null;
    customer_name: string | null;
  }>(`
    SELECT DISTINCT ON (case_id)
      case_id, ticket_id, part, work_location, engineer, customer_name
    FROM daily_call_plan_report_rows
    WHERE case_id IS NOT NULL AND btrim(case_id) <> ''
      AND part IS NOT NULL AND btrim(part) <> ''
      AND lower(btrim(part)) NOT IN ('n/a', 'na', 'none', 'not applicable', 'not available')
    ORDER BY case_id, created_at DESC
  `);

  console.log(`[Backfill] part-cases to sync: ${rows.length}`);

  let done = 0;
  for (const r of rows) {
    await syncPartToInventory({
      case_id: r.case_id,
      ticket_id: r.ticket_id,
      part: r.part,
      work_location: r.work_location,
      engineer: r.engineer,
      customer_name: r.customer_name,
    });
    done += 1;
    if (done % 100 === 0) {
      console.log(`[Backfill] ...${done}/${rows.length}`);
    }
  }

  console.log(`[Backfill] done. processed ${done}`);
}

main()
  .catch((err) => {
    console.error("[Backfill] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabasePool();
  });
