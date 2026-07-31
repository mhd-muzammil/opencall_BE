# Closure Report Auto-Sync — Implementation Plan

**Goal:** every hour, pull the *Flex Closure ASP Report* (date = today) from FieldEZ, import it into
OpenCall, reconcile it against the calls our system closed today, and reflect the Flex closure status
on the Open Call Report row — the same way the Flex WIP report is already automated.

**Status:** IMPLEMENTED (2026-07-31). Everything below is built; the sections that follow are
the design record. Deploy runbook:

1. `npm run migrate:closure-status` (migration `041_closure_report_status.sql` — additive plus
   `closure_date DROP NOT NULL`).
2. Rebuild + redeploy the API. `TZ=Asia/Kolkata` is now set on the API and worker services.
3. Tell the team before this step: the Open Call Report's **Flex Status** cell starts showing
   Flex's closure status for closed calls (the vendor's WIP value moves to `Flex Status (WIP)`).
4. Set `FIELDEZ_CLOSURE_REPORT_NAME=Flex Closure ASP Report` on the `fieldez-worker` service and
   restart it. Leaving it blank keeps the closure job switched off — no other change is needed to
   deploy steps 1–3 safely.

Verification: `npx tsx src/scripts/e2eClosureAutoSync.ts` (needs a live database).

---

## 1. What already exists (you are ~60% built)

Two halves of this feature are already in the codebase and working. The new work is mostly **wiring
them together**, not building from scratch.

**Half one — the FieldEZ robot** (`backend/src/worker/fieldezSyncWorker.ts`, 321 lines)
Logs in to FieldEZ with a warm persistent Chromium profile, finds a report row by name, downloads it
as XLSX, hashes it, skips the upload if unchanged, POSTs it to the OpenCall API with an auto-refreshing
admin token, then triggers report generation. Deployed as the `fieldez-worker` service behind the
`fieldez` compose profile with its own Dockerfile and a persistent volume for the browser session.

**Half two — the closure report import** (`services/closureDates/…`, `case_closure_dates` table)
A manual upload at `POST /api/v1/closure-dates/import` already parses this exact workbook, reads
`Ticket No` / `Case Id` / `Closure Date`, stores them keyed by both ids, and stamps
`output["Case Closed Date"]` onto matched rows at response time via `closureDateEnricher.ts`. The
Closed Calls page already renders region cards from `/closure-dates/summary` and drill-downs from
`/closure-dates/records`.

**What is genuinely new:**

| # | New thing | Why |
|---|---|---|
| 1 | Download a **second** report from FieldEZ, with a **date parameter** | The WIP report takes no parameters; the closure report needs "today" |
| 2 | **Merge** import instead of full replace | Hourly today-only imports through the current code would erase all history |
| 3 | Capture the closure report's **Status** column (not just the date) | Today only `Closure Date` is stored |
| 4 | Overlay that status onto **Flex Status** | The point of the feature |
| 5 | A **reconciliation** view: ours-vs-Flex closed today | The comparison you asked for |

---

## 2. Decisions taken

| Decision | Choice | Consequence |
|---|---|---|
| How Flex Status changes | **Overlay at serve time** — store the closure status in `case_closure_dates`, stamp it onto `output["Flex Status"]` when the report is served | Nothing in `daily_call_plan_report_rows` is mutated. Survives regeneration, fully reversible, original vendor value preserved. Exactly how `Case Closed Date` already works. |
| Hourly download scope | **Today only, merged** | Small fast file. **Requires** replacing DELETE-all with a key-scoped upsert first. |
| On disagreement | **Report only** | A reconciliation panel with three buckets; no automatic row mutation. Humans decide. |

---

## 3. Architecture

```
                    ┌──────────────── fieldez-worker (ONE process, ONE browser) ───────────────┐
                    │                                                                          │
  FieldEZ ◄─────────┤  job "wip"      every 15 min → Flex WIP Report ASP     (existing)         │
                    │  job "closure"  every 60 min → Flex Closure ASP Report (NEW, date=today)  │
                    └───────────────────────────────┬──────────────────────────────────────────┘
                                                    │
                              POST /api/v1/closure-dates/import  (mode=merge)
                                                    │
                                   parse → dedupe by WO → mergeCaseClosureDates()
                                                    │
                                          case_closure_dates
                                    (+ closure_status, failure_code,
                                       work_location, imported_at)
                                                    │
                    ┌───────────────────────────────┼────────────────────────────────┐
                    ▼                                                                ▼
      closureDateEnricher (serve time)                        GET /closure-dates/reconciliation
      output["Case Closed Date"]  (existing)                  ┌ matched
      output["Flex Status"] ← closure status  (NEW)           ├ closed here, not in Flex
      output["Flex Status (WIP)"] ← original   (NEW)          └ closed in Flex, still open here
                    │                                                                │
                    ▼                                                                ▼
        Open Call Report grid                                    Closed Calls page — new card
```

---

## 4. Work breakdown

### Phase 0 — Discovery *(blocking; do this first, one sitting)*

The only real unknown in this whole plan is **what the FieldEZ download dialog looks like for the
closure report**. The WIP report takes no parameters, so the current code does:

```ts
const select = page.locator("select").first();   // assumes the ONLY select is the format picker
await select.selectOption({ label: config.format });
```

Once the closure report's dialog adds date/parameter controls, `.first()` will very likely grab the
wrong dropdown.

**Do:** run a headed Playwright session against FieldEZ, open the *Flex Closure ASP Report* download
dialog, and record:

- the report row's exact display name (must match `hasText` in the locator)
- whether there is a single date field or From/To
- the date input selector and its **expected format** (`DD-MM-YYYY` vs `YYYY-MM-DD` — FieldEZ BIRT
  usually wants `DD-MM-YYYY`)
- how to reliably scope the format `<select>` (by label, by `name`, or by index)
- whether a "Run"/"Apply" click is needed before "Download"

**Deliverable:** ~20 lines appended to `docs/` recording the selectors. Everything after this phase is
deterministic.

---

### Phase 1 — Schema

`infra/postgres/migrations/041_closure_report_status.sql` (additive only):

```sql
ALTER TABLE case_closure_dates
  ADD COLUMN IF NOT EXISTS closure_status       TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS failure_code         TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS resolution_comments  TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS work_location        TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS asp_name             TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS activity_time        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS imported_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS import_source        TEXT NOT NULL DEFAULT 'MANUAL';  -- MANUAL | AUTO

CREATE INDEX IF NOT EXISTS case_closure_dates_closure_date_idx
  ON case_closure_dates (closure_date);
```

Plus the runner `backend/src/scripts/applyClosureReportStatusMigration.ts` and a
`migrate:closure-status` script, following the existing `applyCaseClosureDatesMigration.ts` pattern.

**Bonus win:** the closure report carries `Work Location` (`ASPS01511`) and `ASP Name` directly.
Today `buildLocationCteSql()` has to *recover* the ASP by joining closure rows back to
`daily_call_plan_report_rows` / `flex_raw_records`, and anything it can't resolve lands in the
`unmatched` bucket on the region cards. Storing `work_location` at import time makes that bucket go
to zero.

---

### Phase 2 — Parser + repository *(the dangerous bit)*

**`services/closureDates/closureDateImportService.ts`**

- Pick up the extra columns: `Status`, `Failure Code`, `Resolution comments`, `Work Location`,
  `ASP Name`, `Activity Time`. The existing case-insensitive `pick()` helper already handles this.
- **Dedupe properly.** The closure report emits **one row per part order, not per work order** — your
  two sample files are 15 rows for 3 WOs and 61 rows for far fewer. Current dedupe scans backwards and
  takes "last occurrence wins", which is arbitrary. Replace with: group by normalized WO id → prefer
  the row with a non-empty `Closure Date` → tie-break on the latest `Activity Time`.
- Log the collapse ratio (`15 rows → 3 work orders`) so a format change is visible.

**`repositories/caseClosureDateRepository.ts`**

Add `mergeCaseClosureDates(rows)` alongside the existing `replaceCaseClosureDates`:

```
BEGIN
  DELETE FROM case_closure_dates
   WHERE (wo_id   <> '' AND wo_id   = ANY($1))
      OR (case_id <> '' AND case_id = ANY($2));
  INSERT the incoming rows;
COMMIT
```

Key-scoped delete-then-insert is the simplest correct form here — the table has **two partial unique
indexes** (`wo_id` and `case_id`), so a single `ON CONFLICT` target can't cover both.

**`controllers/closureDateController.ts`**: accept an optional `mode` form field, `replace` (default,
so the existing manual upload button is byte-for-byte unchanged) or `merge` (what the worker sends).
Set `import_source = 'AUTO'` when the caller is the worker.

> ### ⚠️ This is the most dangerous line in the whole change
> `replaceCaseClosureDates` currently runs an unconditional `DELETE FROM case_closure_dates`.
> If the hourly today-only worker points at that function, **one hour after go-live your closure
> table contains only today's rows and every historical closure date is gone.** Note that migration
> 029's own comment says *"re-importing simply upserts the same keys"* — the comment and the code
> disagree. Fix this before the worker exists.

---

### Phase 3 — The Flex Status overlay

**`services/closureDates/closureDateEnricher.ts`**

Widen `loadClosureDateLookup()` to return the full record (date + status + failure code) instead of
just a date string, then in `enrichReportWithClosureDates`:

```
output["Case Closed Date"]   = closure.date              // existing
output["Flex Status (WIP)"]  = output["Flex Status"]     // preserve the vendor value
output["Flex Status"]        = closure.status            // NEW — the overlay
output["Closure Status"]     = closure.status            // optional explicit column
```

Because this is display-only, `flex_status_unchanged_days`, the day-over-day comparison, and the
engineer-productivity exclusions keep computing off the true vendor value. **That is deliberate** —
you don't want a closure overlay resetting stale-status streaks.

**Two things that must be handled in this phase:**

1. **The enricher only runs on the generate endpoint.** It is called from `reportController.ts`
   (~lines 108/116) but *not* on the report-history detail path. Left as-is, "generate" and "reopen
   from history" would show different Flex Statuses for the same day. Add the enricher call to the
   history path.

2. **The overlay changes downstream analytics.** Audit these five consumers of
   `output["Flex Status"]` and confirm the new behaviour is what you want (it probably is — a
   `WO Closed` row shouldn't count as open):
   - `lib/reportDashboardAnalytics.ts:277` — `buildFlexOperationalAnalytics` grouping
   - `lib/reportDashboardAnalytics.ts:179` — `isRequestToCancelFlexStatus` visibility rule
   - `features/dashboard/hooks/useRtplAnalytics.ts:93` — Flex-status breakdown cards
   - `app/page.tsx:5104` — the stale-status modal
   - `shared/src/analytics/engineerProductivity.ts:339` — productivity exclusions

---

### Phase 4 — Reconciliation *(the comparison you asked for)*

New `services/closureDates/closureReconciliationService.ts` +
`GET /api/v1/closure-dates/reconciliation?date=YYYY-MM-DD`, returning three buckets:

| Bucket | Meaning | Action for the team |
|---|---|---|
| `matched` | Closed in ours **and** in the closure report | Nothing — healthy |
| `closedHereNotInFlex` | `same_day_closed = true` or `change_type = 'CLOSED'` today, but no closure record for that date | Engineer closed it in OpenCall, Flex hasn't processed it — or the WO number is wrong. **This is the actionable list.** |
| `closedInFlexStillOpenHere` | Closure record dated today, but our latest report row is not closed | We're carrying a call that's already done — close it |

Data sources both already exist: `getLatestReportClosedCalls()` in
`closedCallWarrantyRepository.ts` (already filters
`WHERE NOT is_excluded AND (change_type = 'CLOSED' OR same_day_closed = TRUE)`) joined against
`case_closure_dates WHERE closure_date = $1`. Scope with `allowedAspCodesForRequest(request)` exactly
like the other three closure endpoints — do not skip this, it's how the region-scoping bug was fixed
on `/records`.

Classify the closure report's free-text `Status` with a small helper in the style of
`flexRawClassify.ts#classifyRawStatus` rather than an enum, so the buckets survive Flex renaming
`"WO Closed"` to something else.

**Frontend:** a "Flex reconciliation" card in `ClosedCallsDashboardView.tsx`, sitting beside the
existing "FieldEZ data closure" and "Raw data" comparison counts — same three-count-with-drill-down
pattern, so no new UI concepts.

---

### Phase 5 — The worker

**Do not create a second worker process.** `chromium.launchPersistentContext` takes an *exclusive
lock* on the profile directory, so a second container sharing the `fieldez-profile` volume would fail
to start; giving it its own profile means a second concurrent FieldEZ login, with the session-limit
and login-pressure problems that brings.

Instead, turn `fieldezSyncWorker.ts` into a **multi-job loop** — one browser, one warm session, two
schedules:

```ts
const JOBS = [
  { key: "wip",     reportName: config.reportName,        intervalMs: config.intervalMs,        run: syncWip },
  { key: "closure", reportName: config.closureReportName, intervalMs: config.closureIntervalMs, run: syncClosure },
];
```

- Each job carries its own `nextRunAt` and its own hash file (`last-<key>.hash` instead of the single
  `last-uploaded.hash`).
- The loop wakes on the **earliest due** job and runs jobs **strictly sequentially** — they share one
  `Page`, so they must never overlap.
- Refactor `downloadReport(page)` → `downloadReport(page, { reportName, format, dateParams })`, with
  `dateParams` filled from Phase 0's findings and `istTodayIso()` (already in the file).
- `syncClosure` POSTs to `/api/v1/closure-dates/import` with the `closureReport` field + `mode=merge`,
  reusing `getToken()` and the existing 401-refresh path verbatim. It does **not** call
  `/reports/…/generate` — the closure overlay applies at serve time, so no regeneration is needed.
- Keep the hash-skip: the today-file will usually differ each hour, but on quiet evenings it won't,
  and skipping saves a pointless write.

**New env** (all defaulted; the closure job no-ops if the report name is blank, so deploying this
worker with no new env changes nothing):

```
FIELDEZ_CLOSURE_ENABLED=true
FIELDEZ_CLOSURE_REPORT_NAME=Flex Closure ASP Report
FIELDEZ_CLOSURE_INTERVAL_MS=3600000
FIELDEZ_CLOSURE_DATE_MODE=today
```

Add them to the `fieldez-worker` environment block in `docker-compose.yml`, to the
`docker-compose.fieldez.yml` overlay, and to `.env.example`. **No new service, no new Dockerfile, no
new volume, no new image build path.**

---

### Phase 6 — Observability

A silently dead hourly worker is worse than no worker.

- Extend `GET /api/v1/closure-dates/status` to
  `{ count, lastImportedAt, lastImportSource, lastClosureDate }` (from `MAX(imported_at)`), and show
  "Auto-synced 14:05" on the Closed Calls page.
- Red dot when `lastImportedAt` is older than 3× the interval.
- `recordActivity({ kind: "CLOSURE_DATES_AUTO_IMPORT", … })` with the per-status tallies — the
  controller already does this for the manual path, just pass the new counts through.

---

## 5. Risks and gotchas

1. **FieldEZ date parameters — the only real unknown.** Phase 0 exists purely to kill it. Secondary:
   `page.locator("select").first()` is fragile once a parameter dialog is in play.
2. **Full-replace destroying history** — see the warning box in Phase 2. Highest-severity item here.
3. **Timezone on the Excel serial → date conversion.** `toIsoDate()` builds `YYYY-MM-DD` from a JS
   `Date` using `getFullYear()/getMonth()/getDate()` — i.e. the *container's* local time. The API and
   worker containers run UTC. A call closed at 02:00 IST would be recorded as the **previous day**.
   Fix either by setting `TZ=Asia/Kolkata` on the API container, or (better) by routing the numeric
   path through `xlsx.SSF.parse_date_code`, which is timezone-free. Cheap to fix, silent if skipped —
   and it will bite hardest on exactly the late-evening closures.
4. **One closure row per part order** — dedupe deliberately (Phase 2), don't let a 5-part WO count as
   5 closures on the region cards.
5. **The overlay changes five downstream analytics call sites** — listed in Phase 3.
6. **Enricher missing on the history path** — inconsistent Flex Status between generate and reopen.
7. **Free-text `Status`** — classify, don't enum.
8. **Region scoping on the new endpoint** — reuse `allowedAspCodesForRequest`; this was already a
   fixed bug once on `/records`.

---

## 6. Test plan

**Unit (vitest, already configured):**

- Parser dedupe against both sample workbooks — assert 15 rows → 3 work orders, and that the row with
  a real `Closure Date` wins.
- `toIsoDate` around the IST midnight boundary, with `TZ=UTC` forced in the test env.
- `mergeCaseClosureDates`: import a full month, then a today-only merge, assert the month survives and
  today's rows are updated in place. This is the regression test for the delete-everything bug.
- The reconciliation bucketer with a hand-built fixture covering all three outcomes.

**E2E script** (`backend/src/scripts/e2eClosureAutoSync.ts`, in the style of the existing
`e2eSameDayClosedCalls.ts`): seed a report → merge-import a closure file → assert the Flex Status
overlay lands on the right rows and the three buckets come out right.

**Worker dry run:** headed mode, `FIELDEZ_CLOSURE_INTERVAL_MS` set low, `OPENCALL_API_URL` pointed at
a local API, one cycle, eyeball the log line.

---

## 7. Rollout order

Each step is independently deployable and safe to stop at.

| # | Step | Visible change |
|---|---|---|
| 1 | Phase 0 discovery | none — blocking research |
| 2 | Migration + merge repo + parser | none (new columns unused) |
| 3 | Manual upload tested with `mode=merge` from the UI | none |
| 4 | Enricher overlay + history path | **yes** — Flex Status starts changing. Tell the team first. |
| 5 | Reconciliation endpoint + panel | **yes** — new card on Closed Calls |
| 6 | Worker closure job enabled, interval 1h | the whole thing goes hands-free |

Rough effort: Phase 0 half a day, Phases 1–2 one day, Phase 3 half a day, Phase 4 one day
(mostly frontend), Phase 5 half a day, Phase 6 a few hours. **≈4 working days.**

---

## Appendix — the closure report's shape

62 columns, sheet name `Report`. The ones that matter:

| Column | Use |
|---|---|
| `Ticket No` | WO id — primary match key (already used) |
| `Case Id` | fallback match key (already used) |
| `Closure Date` | already stored |
| `Status` | **NEW** — the value that overlays Flex Status (`WO Closed` in both samples) |
| `Work Location` | **NEW** — ASP code (`ASPS01511`), kills the `unmatched` region bucket |
| `ASP Name` | **NEW** — display (`RENDERWAYS TECHNOLOGY PRIVATE LIMITED- Hosur`) |
| `Failure Code` | **NEW** — `73 used & consumed`, `72` |
| `Resolution comments` | **NEW** — engineer's closing note |
| `Activity Time` | **NEW** — dedupe tie-break |
| `Part Order No`, `Good Part No` | the reason rows repeat per WO — ignore, but dedupe on them |
