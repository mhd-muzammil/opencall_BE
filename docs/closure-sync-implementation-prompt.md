# Implementation prompt — Closure Report Auto-Sync

> Paste this whole thing into Claude Code / Cursor at the repo root.
> Everything below is decided. Do not re-open the design questions.

---

## Context

Repo: `open_call_2` (Express + TypeScript, ESM backend) and `opencall-frontend` (Next.js).

Two halves of this feature already exist and work:

1. **The FieldEZ robot** — `backend/src/worker/fieldezSyncWorker.ts`. Logs into FieldEZ with a warm
   persistent Chromium profile, downloads "Flex WIP Report ASP" as XLSX, hashes it, skips if
   unchanged, POSTs to `/api/v1/uploads` with an auto-refreshing admin token, then calls
   `/api/v1/reports/daily-call-plan/generate`. Runs as the `fieldez-worker` compose service behind
   the `fieldez` profile.
2. **The closure import** — `POST /api/v1/closure-dates/import` +
   `services/closureDates/closureDateImportService.ts` + the `case_closure_dates` table. Already
   parses this exact workbook (Ticket No / Case Id / Closure Date) and stamps
   `output["Case Closed Date"]` onto matched report rows at serve time via `closureDateEnricher.ts`.

**Goal:** every hour, download today's *Flex Closure ASP Report* from FieldEZ, import it the same
way the "Import Closure Dates" button does, and use it to rewrite the **Flex Status** cell of the
calls the team marked **Case-Closed** on the Open Call Report — plus a reconciliation view for the
rows that don't match.

---

## The FieldEZ download dialog — confirmed, do not guess

Clicking the download icon on the report row opens a modal titled **Download Report** containing,
in this order:

| Control | Type | Notes |
|---|---|---|
| `From Date` | text input, placeholder `yyyy-mm-dd`, calendar button beside it | **required** (red asterisk) |
| `To Date` | text input, placeholder `yyyy-mm-dd`, calendar button beside it | **required** |
| `Select Format` | `<select>`, default option text "Choose format" | the only `<select>` in the modal |
| `Download` | orange button, label exactly `Download` | submits |

Consequences for the worker:

- Fill **From Date = To Date = today in IST**, formatted `YYYY-MM-DD`. `istTodayIso()` already exists
  in `fieldezSyncWorker.ts` and returns exactly that format — reuse it, do not write a new formatter.
- Type into the text inputs directly (`fill`). Do **not** open the calendar pickers.
- The date fields are `<input>`, not `<select>`, so `page.locator("select").first()` still resolves
  to the format picker. Even so, scope it by its visible label rather than position, so this doesn't
  silently break if FieldEZ adds a parameter dropdown later.
- The dates are required, so the existing `downloadReport()` cannot be reused as-is — it never fills
  them. Refactor it to `downloadReport(page, { reportName, format, fromDate, toDate })` where the
  date fields are filled only when the values are supplied (the WIP report's dialog may not have
  them — check at runtime, don't assume).

---

## Decisions already made — implement these, don't propose alternatives

1. **Overlay at serve time.** Store the closure status in `case_closure_dates` and stamp it onto the
   row when the report is served. **Never** write to `daily_call_plan_report_rows.flex_status`.
2. **Today only, merged.** The hourly import touches only the keys in the incoming file.
3. **Report only.** Mismatches are surfaced in a reconciliation view. Nothing is auto-closed.
4. **No new nav item.** Everything surfaces on the existing Closed Calls and Open Call Report pages.
5. **One worker process.** Extend the existing worker into a two-job loop. No second container.

## Hard constraints — violating any of these is a bug

- ❌ Do **not** route the hourly import through `replaceCaseClosureDates` — it runs an unconditional
  `DELETE FROM case_closure_dates`.
- ❌ Do **not** add a second worker service or a second FieldEZ profile directory.
- ❌ Do **not** write to `daily_call_plan_report_rows` anywhere in this feature.
- ❌ Do **not** change the manual upload's behaviour — `mode` defaults to `replace`.
- ❌ Do **not** add `flex_status` to `EDITABLE_REPORT_ROW_FIELDS`.

---

## Phase 1 — Schema

`infra/postgres/migrations/041_closure_report_status.sql`, additive plus one relaxation:

```sql
ALTER TABLE case_closure_dates
  ALTER COLUMN closure_date DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS closed_on            DATE,
  ADD COLUMN IF NOT EXISTS closure_status       TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS status_remarks       TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS failure_code         TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS resolution_comments  TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS work_location        TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS asp_name             TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS activity_time        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS imported_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS import_source        TEXT NOT NULL DEFAULT 'MANUAL';

UPDATE case_closure_dates SET closed_on = closure_date WHERE closed_on IS NULL;
CREATE INDEX IF NOT EXISTS case_closure_dates_closed_on_idx ON case_closure_dates (closed_on);
```

**Why `DROP NOT NULL` matters:** in the two real sample workbooks, **9 of 74 rows** are
`Closed - Canceled` with `Closure Date = NULL`. They are closed in Flex and must be stored.
`closed_on` is `closure_date` when present, otherwise the Activity Time's calendar day.

Add the runner `backend/src/scripts/applyClosureReportStatusMigration.ts` and a
`migrate:closure-status` npm script, following `applyCaseClosureDatesMigration.ts`.

---

## Phase 2 — Parser and repository

### `services/closureDates/closureDateImportService.ts`

Read these columns (the existing case-insensitive `pick()` helper handles the lookup):
`Ticket No`, `Case Id`, `Status`, `Status Remarks`, `Closure Date`, `Failure Code`,
`Resolution comments`, `Work Location`, `ASP Name`, `Activity Time`.

**De-duplication.** The report emits one row **per part order**, not per work order — 60 rows for 48
work orders in one sample, 5 rows for a single WO in another. Group by normalised WO id and keep one
record, choosing deterministically: prefer a row with a non-empty `Closure Date`, then the latest
`Activity Time`, then file order. The current backwards-scan "last occurrence wins" is arbitrary and
picks a blank Failure Code on real data — replace it. Log the collapse ratio.

**Do not skip rows with no closure date.** Store them with `closure_date = NULL` and
`closed_on = date(activity_time)`.

**Date conversion.** `toIsoDate()` currently builds `YYYY-MM-DD` from a JS `Date` using
`getFullYear()/getMonth()/getDate()` — the container's local time, which is UTC. Real rows have
Activity Times at 00:31 and 05:01 IST, which shift to the previous day. Route the numeric path
through `xlsx.SSF.parse_date_code` (timezone-free) **and** set `TZ=Asia/Kolkata` on the API and
worker containers. Add a unit test that pins `TZ=UTC` and asserts the IST day.

**Status classification.** Add a helper in the style of `flexRawData/flexRawClassify.ts` —
**CANCEL is tested before CLOSED**. The literal `"Closed - Canceled"` contains both words; get the
order wrong and 9 of every 74 rows count as genuine completions.

### `repositories/caseClosureDateRepository.ts`

Add `mergeCaseClosureDates(rows)` beside the existing `replaceCaseClosureDates`:

```
BEGIN
  DELETE FROM case_closure_dates
   WHERE (wo_id   <> '' AND wo_id   = ANY($1))
      OR (case_id <> '' AND case_id = ANY($2));
  INSERT the deduped incoming rows;
COMMIT
```

The table carries **two** partial unique indexes (`wo_id` and `case_id`), so a single `ON CONFLICT`
target cannot cover both — key-scoped delete-then-insert is the correct shape. Scope by **both** key
sets or the insert will violate `case_closure_dates_case_id_uidx`.

### `controllers/closureDateController.ts`

Accept an optional `mode` form field: `replace` (default — the existing button is unchanged) or
`merge`. Set `import_source = 'AUTO'` for the worker. Emit `recordActivity` with
`kind: "CLOSURE_DATES_AUTO_IMPORT"` and per-status tallies.

---

## Phase 3 — The Flex Status overlay

Widen `loadClosureDateLookup()` to return the full record. In `closureDateEnricher.ts`, for each
matched row:

```
output["Flex Status (WIP)"] = output["Flex Status"]   // preserve the vendor value
output["Flex Status"]       = closure.status          // "WO Closed" / "Closed - Canceled"
output["Status Remarks"]    = closure.statusRemarks
output["Case Closed Date"]  = closure.closedOn        // existing behaviour
```

Match on `ticket_id` first, then `case_id`, both `trim()` + `toUpperCase()` via the existing
`normalizeKey`.

Two things that must ship in this phase:

1. **Call the enricher on the report-history detail path too.** It currently runs only from the
   generate path in `reportController.ts` (~lines 108/116), so "generate" and "reopen from history"
   would disagree for the same day.
2. **Re-check the five readers of `output["Flex Status"]`** and confirm the new behaviour is
   intended (a closed row dropping out of open counts almost certainly is):
   - `lib/reportDashboardAnalytics.ts:277` — `buildFlexOperationalAnalytics`
   - `lib/reportDashboardAnalytics.ts:179` — `isRequestToCancelFlexStatus`
   - `features/dashboard/hooks/useRtplAnalytics.ts:93` — `flexStatusMetrics`
   - `app/page.tsx:5104` — stale-status modal
   - `shared/src/analytics/engineerProductivity.ts:339` — productivity exclusions

Because the overlay is display-only, `flex_status_unchanged_days`, `previous_flex_status` and the
day-over-day comparison keep computing off the stored vendor value. That is deliberate — a closure
must not reset the stale-status streak.

---

## Phase 4 — Reconciliation

New `services/closureDates/closureReconciliationService.ts` and
`GET /api/v1/closure-dates/reconciliation?date=YYYY-MM-DD`.

**The closed set is defined by RTPL status, not by `same_day_closed`.** Use the same rule the
"RTPL HOURES STATUS" tiles use — `rtplEveningFirstStatusForAnalytics`: evening status if present and
not a placeholder, otherwise the morning-derived status. Rows in today's report whose evening-first
RTPL status is in the configured closed-status list.

> **Ask the user before writing the query:** is `Case-Closed` the only status that counts, or do
> `WO-closed`, `Need to Close`, `Closed-cancellation`, `Under Cancellation` and `Need to Cancel`
> (all present in `020_rtpl_statuses.sql` or on the live tiles) count too? Make the list a constant,
> not a hard-coded string.

Three buckets:

| Bucket | Definition |
|---|---|
| `matched` | in the closed set **and** has a closure record for that day |
| `closedHereNotInFlex` | in the closed set, no closure record — include hours since we closed it |
| `closedInFlexNotHere` | closure record for that day, not in the closed set — include the closure status so cancelled rows are distinguishable |

Scope with `allowedAspCodesForRequest(request)` exactly as `/closure-dates/records` does, and return
**403** (not a silent empty list) for an out-of-scope `asp` parameter. That endpoint shipped once
with `asp` going straight to SQL — don't rebuild the hole.

Store `work_location` from the file so region attribution stops depending on `buildLocationCteSql`
joining back to report rows; the `unmatched` bucket should go to zero.

**Frontend:** a "Flex reconciliation" card in `ClosedCallsDashboardView.tsx`, beside the existing
"FieldEZ data closure" / "Raw data closures" rows. Same three-count-with-drill-down pattern. No new
route, no new sidebar entry.

---

## Phase 5 — The worker

Convert `fieldezSyncWorker.ts` into a multi-job loop. **One process, one browser, one profile lock**
— `chromium.launchPersistentContext` takes an exclusive lock on the user-data directory, so a second
container sharing the `fieldez-profile` volume crash-loops, and a separate profile means a second
concurrent FieldEZ login.

```ts
const JOBS = [
  { key: "wip",     reportName: config.reportName,        intervalMs: config.intervalMs,        run: syncWip },
  { key: "closure", reportName: config.closureReportName, intervalMs: config.closureIntervalMs, run: syncClosure },
];
```

- Each job keeps its own `nextRunAt` and its own hash file — `last-wip.hash`, `last-closure.hash`.
  A single shared `last-uploaded.hash` makes the two jobs clobber each other.
- Wake on the earliest due job. Run jobs **strictly sequentially** — they share one `Page`.
- `syncClosure` fills From/To with `istTodayIso()`, selects XLSX, downloads, hashes, and POSTs to
  `/api/v1/closure-dates/import` with the `closureReport` field and `mode=merge`. Reuse `getToken()`
  and the existing retry-once-on-401 path verbatim. It does **not** call
  `/reports/daily-call-plan/generate` — the overlay applies at serve time.
- Reuse `ensureReportsPage()` so a lapsed session re-logs in for the closure job too.

New env, all defaulted so a deploy without them changes nothing:

```
FIELDEZ_CLOSURE_REPORT_NAME=       # blank ⇒ the closure job is never scheduled
FIELDEZ_CLOSURE_INTERVAL_MS=3600000
FIELDEZ_CLOSURE_DATE_MODE=today
```

Add them to the `fieldez-worker` environment block in `docker-compose.yml`, to
`docker-compose.fieldez.yml`, and to `.env.example`. No new service, Dockerfile, volume or image.

---

## Phase 6 — Observability

- Extend `GET /api/v1/closure-dates/status` to `{ count, lastImportedAt, lastImportSource, lastClosedOn }`
  from `MAX(imported_at)`.
- Show "Auto-synced HH:mm" on the Closed Calls page; turn it red when `lastImportedAt` is older than
  3× the interval. A silently dead worker keeps serving yesterday's statuses while looking healthy.

---

## Tests that must pass

**Unit (vitest, already configured):**

- Parser collapses a 5-part work order to one record and keeps the non-blank Failure Code.
- `Closed - Canceled` classifies as cancelled, never closed.
- A row with `Closure Date = NULL` is stored, with `closed_on` from Activity Time.
- `toIsoDate` returns the IST day for 00:31 and 05:01 timestamps with `TZ=UTC` forced.
- **The history test:** import a 48-work-order file, then merge-import a 13-work-order today-only
  file with zero key overlap. Assert the table holds 61 rows, not 13. This is the regression test for
  the delete-everything bug.
- Re-importing the same work order with a changed status updates in place — no unique violation.
- Reconciliation bucketer over a fixture covering all three outcomes.

**E2E** (`backend/src/scripts/e2eClosureAutoSync.ts`, in the style of `e2eSameDayClosedCalls.ts`):
seed a report → merge-import a closure file → assert the overlay lands on the right rows, the vendor
value survives in `Flex Status (WIP)`, `flex_status_unchanged_days` is unchanged, and the three
buckets come out right.

**Worker dry run:** headed mode, short interval, `OPENCALL_API_URL` pointed at a local API, one cycle.

---

## Ship order

Each step is independently deployable and safe to stop at.

1. Migration + merge repository + parser — no visible change.
2. Manual upload tested by hand with `mode=merge` — no visible change.
3. Enricher overlay + history path — **visible**, tell the team before deploying.
4. Reconciliation endpoint + Closed Calls card — **visible**.
5. Worker closure job enabled, interval 1h — hands-free.
