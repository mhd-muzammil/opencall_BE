// "We disabled a lot of statuses, but the picker shows every status again."
//
// The RTPL status list is admin-curated data living in `rtpl_statuses`, and the
// Work Order Details & Entry picker renders exactly the rows with
// is_active = TRUE (listRtplStatusesForDropdown). Removing a status from the
// list should therefore be permanent — but migration 020's seed used to run on
// every deploy with only `ON CONFLICT (name) DO NOTHING` to protect it. That
// clause protects a status that still EXISTS; it does nothing for one that was
// DELETED, because there is no conflicting row. The seed re-inserted it, and a
// re-inserted row takes is_active's DEFAULT of true.
//
// Result: every post-deploy `applyAllMigrations` run refilled the picker with
// statuses the admin had removed, and brought back the original spelling of any
// status that had been RENAMED (the row no longer holds the seeded name, so the
// seed sees no conflict) — which is how "To be Scheduled" and "To Be Scheduled"
// ended up side by side in one group.
//
// The seed is fixed to populate an empty table only. This script cleans up the
// rows an earlier run already resurrected.
//
// HOW A RESURRECTED ROW IS IDENTIFIED
//   The seed INSERT sets no created_by, so every seeded row has created_by NULL,
//   and all rows from one run share an identical created_at (NOW() is the
//   transaction timestamp). The EARLIEST such cohort is the genuine first
//   install; any later created_by-NULL cohort can only have come from a re-run.
//   Admin-created statuses always carry created_by and are never touched.
//
// Reports by default and writes nothing. Safe to run against production.
//
// Usage (local): pnpm tsx src/scripts/diagnoseRtplStatusResurrection.ts [--deactivate]
// Usage (prod):  node dist/scripts/diagnoseRtplStatusResurrection.js [--deactivate]
//   --deactivate hides the resurrected statuses again (is_active = FALSE). It is
//   reversible from Admin Console -> RTPL Statuses -> Enable, and it never
//   deletes a row, so report rows already carrying the value keep rendering it.
import { closeDatabasePool, query } from "../config/database.js";

interface StatusRow {
  id: string;
  name: string;
  category: string;
  is_active: boolean | null;
  created_at: string;
  updated_by: string | null;
  usage_count: string;
}

const DEACTIVATE = process.argv.includes("--deactivate");

function line(): string {
  return "=".repeat(78);
}

async function main(): Promise<void> {
  // usage_count answers "does hiding this strand any existing work?" — it counts
  // report rows still carrying the value in any of the three status columns.
  const { rows } = await query<StatusRow>(`
    SELECT
      s.id::TEXT AS id,
      s.name,
      s.category,
      s.is_active,
      s.created_at::TEXT AS created_at,
      s.updated_by::TEXT AS updated_by,
      (
        SELECT COUNT(*)
        FROM daily_call_plan_report_rows r
        WHERE lower(r.rtpl_status) = lower(s.name)
           OR lower(r.evening_rtpl_status) = lower(s.name)
           OR lower(r.previous_rtpl_status) = lower(s.name)
      )::TEXT AS usage_count
    FROM rtpl_statuses s
    WHERE s.created_by IS NULL
    ORDER BY s.created_at ASC, s.sort_order ASC, s.name ASC
  `);

  console.log(`\n${line()}`);
  console.log("RTPL status list — seed-inserted rows (created_by IS NULL)");
  console.log(line());

  if (rows.length === 0) {
    console.log(
      "\n  No seed-inserted statuses at all. Every status in the list was created\n" +
        "  by an admin, so nothing here was ever resurrected by a migration run.\n",
    );
    return;
  }

  const cohorts = [...new Set(rows.map((row) => row.created_at))].sort();
  const [firstInstall, ...resurrections] = cohorts;

  console.log(`\n  Seed cohorts found: ${cohorts.length}`);
  console.log(`    first install : ${firstInstall}`);
  for (const cohort of resurrections) {
    console.log(`    RE-RUN        : ${cohort}`);
  }

  if (resurrections.length === 0) {
    console.log(
      "\n  Only the original install cohort is present — no status has been\n" +
        "  resurrected by a re-run. Nothing to clean up.\n",
    );
    return;
  }

  const resurrected = rows.filter((row) => row.created_at !== firstInstall);
  // An admin editing a resurrected row means they have since looked at it and
  // decided to keep it. Report it, but never hide it behind their back.
  const adminTouched = resurrected.filter((row) => row.updated_by !== null);
  const safeToHide = resurrected.filter(
    (row) => row.updated_by === null && row.is_active !== false,
  );

  console.log(
    `\n  ${resurrected.length} status(es) came back from a migration re-run:\n`,
  );
  for (const row of resurrected) {
    const state = row.is_active === false ? "inactive" : "ACTIVE";
    const touched = row.updated_by ? "  [edited by an admin since — left alone]" : "";
    console.log(
      `    ${state.padEnd(8)} ${row.name.padEnd(34)} ${row.category.padEnd(26)}` +
        ` used by ${row.usage_count.padStart(6)} report row(s)${touched}`,
    );
  }

  if (adminTouched.length > 0) {
    console.log(
      `\n  ${adminTouched.length} of those were edited by an admin after they reappeared.\n` +
        "  Those are deliberate keeps and are never deactivated by this script.",
    );
  }

  if (safeToHide.length === 0) {
    console.log(
      "\n  None of them are currently active and untouched, so there is nothing\n" +
        "  left to hide.\n",
    );
    return;
  }

  if (!DEACTIVATE) {
    console.log(
      `\n  ${safeToHide.length} resurrected status(es) are ACTIVE and would be hidden.\n` +
        "  Re-run with --deactivate to set is_active = FALSE on exactly those rows.\n" +
        "  Nothing is deleted, and Admin Console -> RTPL Statuses -> Enable undoes it.\n",
    );
    console.log(line());
    return;
  }

  const result = await query(
    `
      UPDATE rtpl_statuses
      SET is_active = FALSE, updated_at = NOW()
      WHERE id = ANY($1::uuid[])
    `,
    [safeToHide.map((row) => row.id)],
  );

  console.log(
    `\n  Deactivated ${result.rowCount ?? 0} status(es). They are gone from the\n` +
      "  Work Order Details & Entry picker on the next load. Report rows that\n" +
      "  already carry one of these values still display it unchanged.\n",
  );
  console.log(line());
}

main()
  .catch((error: unknown) => {
    console.error("diagnoseRtplStatusResurrection failed:", error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabasePool());
