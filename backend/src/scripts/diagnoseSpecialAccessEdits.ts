// READ-ONLY diagnostic: "did the special-access login lose any of today's work?"
//
// A special-access credential edits report rows through
// PATCH /special-access/report-rows/:id, and every successful save is written to
// `user_activity_log` as REPORT_ROW_EDITED with actor_email
// "special-access:<username>". This script replays that log for a day and checks
// each recorded edit against what the database holds NOW, so a full day of work
// can be confirmed intact (or the exact tickets needing re-entry can be listed)
// without guessing.
//
// It answers three separate questions:
//
//   1. WHAT WAS SAVED     – every edit the credential made that day, in order.
//   2. DID IT SURVIVE     – for each recorded RTPL status transition, does the
//                           ticket's newest persisted row still show the status
//                           that was saved? A mismatch is a genuinely lost edit
//                           (overwritten by a regeneration or a later save).
//   3. WRONG-ROW RISK     – `serial_no` is POSITIONAL and recomputed on every
//                           regeneration, while the browser used to look rows up
//                           by serial. When the same serial is recorded against
//                           two DIFFERENT tickets close together, the editor's
//                           serial->ticket mapping moved underneath the user and
//                           an edit may have landed on the wrong work order.
//
// Writes nothing. Safe to run against production.
//
// Usage (local): pnpm tsx src/scripts/diagnoseSpecialAccessEdits.ts [YYYY-MM-DD] [username]
// Usage (prod):  node dist/scripts/diagnoseSpecialAccessEdits.js [YYYY-MM-DD] [username]
//   No date = today in Asia/Kolkata. No username = every special-access login.
import { istTodayIso } from "@opencall/shared";
import { closeDatabasePool, pool } from "../config/database.js";

/** Suspicion window for the wrong-row signature. */
const SERIAL_COLLISION_WINDOW_MS = 10 * 60 * 1000;

interface EditRow {
  occurred_at: string;
  actor_email: string | null;
  username: string | null;
  report_id: string | null;
  row_id: string | null;
  serial_no: string | null;
  ticket_id: string | null;
  work_location: string | null;
  changed_fields: string[] | null;
  from_status: string | null;
  to_status: string | null;
}

interface CurrentRow {
  ticket_id: string;
  report_id: string;
  report_date: string;
  serial_no: number;
  rtpl_status: string | null;
  evening_rtpl_status: string | null;
  remarks: string | null;
  updated_at: string | null;
}

function normalizeStatus(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeTicket(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

async function main(): Promise<void> {
  const [dateArg, usernameArg] = process.argv.slice(2);
  const reportDate = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg)
    ? dateArg
    : istTodayIso();
  const username = dateArg && !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)
    ? dateArg
    : usernameArg;

  console.log("=".repeat(78));
  console.log(`Special-access edit audit — ${reportDate} (Asia/Kolkata)`);
  if (username) console.log(`Filtered to credential: ${username}`);
  console.log("=".repeat(78));

  // --- 1. Everything the credential saved that day --------------------------
  const edits = await pool.query<EditRow>(
    `
      SELECT
        a.occurred_at::TEXT                              AS occurred_at,
        a.actor_email,
        a.metadata->>'specialAccessUsername'             AS username,
        a.metadata->>'reportId'                          AS report_id,
        a.target_id                                      AS row_id,
        a.metadata->>'serialNo'                          AS serial_no,
        a.metadata->>'ticketId'                          AS ticket_id,
        a.metadata->>'workLocation'                      AS work_location,
        ARRAY(
          SELECT jsonb_array_elements_text(a.metadata->'changedFields')
        )                                                AS changed_fields,
        a.metadata#>>'{rtplStatusChange,fromStatus}'     AS from_status,
        a.metadata#>>'{rtplStatusChange,toStatus}'       AS to_status
      FROM user_activity_log a
      WHERE a.event_type = 'REPORT_ROW_EDITED'::activity_event_type
        AND a.actor_email LIKE 'special-access:%'
        AND (a.occurred_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date
        AND ($2::text IS NULL OR a.metadata->>'specialAccessUsername' = $2)
      ORDER BY a.occurred_at ASC
    `,
    [reportDate, username ?? null],
  );

  if (edits.rowCount === 0) {
    console.log("\nNo special-access row edits recorded for this day.");
    console.log(
      "If work WAS done, the saves never reached the server — check the API logs\n" +
        "for 401/403 on PATCH /api/v1/special-access/report-rows/:id.",
    );
    return;
  }

  console.log(`\n[1] SAVES RECORDED — ${edits.rowCount} edit(s)\n`);
  for (const e of edits.rows) {
    const time = e.occurred_at.slice(0, 19);
    const fields = (e.changed_fields ?? []).join(", ") || "(none recorded)";
    const transition = e.to_status
      ? `  status: ${e.from_status ?? "(blank)"} -> ${e.to_status}`
      : "";
    console.log(
      `  ${time}  ${e.username ?? e.actor_email}  WO ${e.ticket_id ?? "?"}` +
        ` [${e.work_location ?? "?"}]  serial ${e.serial_no ?? "?"}\n` +
        `      fields: ${fields}${transition ? `\n    ${transition}` : ""}`,
    );
  }

  const byUser = new Map<string, number>();
  for (const e of edits.rows) {
    const key = e.username ?? e.actor_email ?? "unknown";
    byUser.set(key, (byUser.get(key) ?? 0) + 1);
  }
  console.log("\n  Totals:");
  for (const [user, count] of byUser) {
    console.log(`    ${user}: ${count} edit(s)`);
  }

  // --- 2. Did each recorded status transition survive? ----------------------
  // Compare against the NEWEST persisted row for the ticket, which is what the
  // Records page and every downstream count actually read.
  const tickets = [
    ...new Set(
      edits.rows
        .map((e) => normalizeTicket(e.ticket_id))
        .filter((t) => t.length > 0),
    ),
  ];

  const current = await pool.query<CurrentRow>(
    `
      SELECT DISTINCT ON (UPPER(TRIM(rows.ticket_id)))
        UPPER(TRIM(rows.ticket_id))       AS ticket_id,
        rows.report_id::TEXT              AS report_id,
        reports.report_date::TEXT         AS report_date,
        rows.serial_no,
        rows.rtpl_status,
        rows.evening_rtpl_status,
        rows.remarks,
        rows.updated_at::TEXT             AS updated_at
      FROM daily_call_plan_report_rows rows
      JOIN daily_call_plan_reports reports ON reports.id = rows.report_id
      WHERE UPPER(TRIM(rows.ticket_id)) = ANY($1::text[])
      ORDER BY
        UPPER(TRIM(rows.ticket_id)),
        reports.report_date DESC,
        reports.created_at DESC
    `,
    [tickets],
  );

  const currentByTicket = new Map(current.rows.map((r) => [r.ticket_id, r]));

  // Last recorded intent per ticket wins: an earlier transition superseded by a
  // later save by the same person is not a loss.
  const lastIntent = new Map<string, EditRow>();
  for (const e of edits.rows) {
    if (!e.to_status) continue;
    lastIntent.set(normalizeTicket(e.ticket_id), e);
  }

  const lost: Array<{ edit: EditRow; now: CurrentRow | undefined }> = [];
  for (const [ticket, edit] of lastIntent) {
    const now = currentByTicket.get(ticket);
    const saved = normalizeStatus(edit.to_status);
    const survives =
      now !== undefined &&
      (normalizeStatus(now.rtpl_status) === saved ||
        normalizeStatus(now.evening_rtpl_status) === saved);
    if (!survives) {
      lost.push({ edit, now });
    }
  }

  console.log(
    `\n[2] SURVIVAL CHECK — ${lastIntent.size} ticket(s) with a recorded status change`,
  );
  if (lost.length === 0) {
    console.log(
      "\n  OK: every status a special-access login saved today is still the\n" +
        "  status persisted on that ticket's newest row. Nothing was lost.",
    );
  } else {
    console.log(
      `\n  ${lost.length} ticket(s) NO LONGER show the status that was saved —\n` +
        "  these are the edits that need re-entering:\n",
    );
    for (const { edit, now } of lost) {
      console.log(
        `    WO ${edit.ticket_id}  saved "${edit.to_status}" at ${edit.occurred_at.slice(11, 19)}\n` +
          `      now: morning="${now?.rtpl_status ?? "(row not found)"}"` +
          ` evening="${now?.evening_rtpl_status ?? ""}"` +
          ` (report ${now?.report_date ?? "?"}, updated ${now?.updated_at ?? "?"})`,
      );
    }
  }

  // --- 3. Wrong-row signature ----------------------------------------------
  // The browser used to resolve the open editor by positional serial. If the
  // report object was replaced mid-edit, that serial could name a different
  // ticket. The log shows it as one serial recorded against two tickets in a
  // short window.
  const bySerial = new Map<string, EditRow[]>();
  for (const e of edits.rows) {
    if (!e.serial_no) continue;
    const list = bySerial.get(e.serial_no) ?? [];
    list.push(e);
    bySerial.set(e.serial_no, list);
  }

  const collisions: Array<[string, EditRow, EditRow]> = [];
  for (const [serial, list] of bySerial) {
    for (let i = 1; i < list.length; i += 1) {
      const previous = list[i - 1]!;
      const currentEdit = list[i]!;
      if (
        normalizeTicket(previous.ticket_id) !== normalizeTicket(currentEdit.ticket_id) &&
        Date.parse(currentEdit.occurred_at) - Date.parse(previous.occurred_at) <=
          SERIAL_COLLISION_WINDOW_MS
      ) {
        collisions.push([serial, previous, currentEdit]);
      }
    }
  }

  console.log("\n[3] WRONG-ROW RISK (positional serial reused across tickets)");
  if (collisions.length === 0) {
    console.log(
      "\n  OK: no serial number was recorded against two different tickets\n" +
        "  within the suspicion window. No sign of an edit landing on the wrong WO.",
    );
  } else {
    console.log(
      `\n  ${collisions.length} suspicious pair(s). Verify these work orders by hand —\n` +
        "  an edit may have been written onto the second ticket by mistake:\n",
    );
    for (const [serial, a, b] of collisions) {
      console.log(
        `    serial ${serial}: WO ${a.ticket_id} at ${a.occurred_at.slice(11, 19)}` +
          `  ->  WO ${b.ticket_id} at ${b.occurred_at.slice(11, 19)}`,
      );
    }
  }

  console.log(`\n${"=".repeat(78)}`);
}

main()
  .catch((error: unknown) => {
    console.error("diagnoseSpecialAccessEdits failed:", error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabasePool());
