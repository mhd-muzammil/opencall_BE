# Inventory HP Stock Sync — Operations & Hardening

How Opencall pushes cases-with-parts into the Inventory **HP Stock** system, how to
operate it in production, and a prioritized list of hardening work that is **not yet
done** (deliberately deferred).

## Overview

- **What it does:** when an Opencall daily-call-plan case has a `part`, it is created/
  updated as an `HPStockItem` in the Inventory app.
- **Code:** `backend/src/services/inventorySyncService.ts` (`syncPartToInventory`).
- **Triggers:** report-row **insert** (report generation) and report-row **edit**, in
  `backend/src/repositories/dailyCallPlanReportRepository.ts`. Fire-and-forget.
- **Idempotent:** upsert by `case_id`. Never overwrites `status` or `transition_history`;
  fills blank fields only and refreshes the details snapshot.
- **Dual-mode (env-gated):**
  - **Production** — `INVENTORY_API_URL` set → upsert via the Inventory HTTP API
    (`GET/POST/PATCH /api/hp-stock/items/`, JWT login at `/api/auth/login/`, token cached
    ~4 min, re-login on 401).
  - **Local dev** — `INVENTORY_API_URL` unset → direct write to the Inventory SQLite file
    via `node:sqlite` at `INVENTORY_DB_PATH`.
- **Region** is derived from the case work-location ASP code via `mapAspCodeToRegion`
  (ASPS01461→chennai, 01463→vellore, 01465→salem, 01489→kanchipuram, 01511→hosur;
  unknown → empty).

## Configuration (Opencall backend env)

| Var | Where | Notes |
|---|---|---|
| `INVENTORY_API_URL` | prod | e.g. `https://inventoryback.systimus.in/api`. Presence switches to the API path. |
| `INVENTORY_API_USER` | prod | service user; **must** be `super_admin`/`admin`/`manager` |
| `INVENTORY_API_PASSWORD` | prod | must equal the service user's password |
| `INVENTORY_DB_PATH` | local only | path to `inventory_backend/db.sqlite3`; ignored when `INVENTORY_API_URL` is set |

## Production deployment runbook

1. **Deploy** the Opencall backend from `main` (build so `dist/` is fresh).
2. **Set env vars** (table above) on the Opencall backend service; redeploy so the running
   container picks them up. Verify inside the container: `echo "$INVENTORY_API_URL"`.
3. **Create the service user** in the Inventory backend (writes to the prod Inventory DB):
   ```bash
   python manage.py shell -c "
   from django.contrib.auth.models import User
   from authenticate.models import UserProfile
   u,_ = User.objects.get_or_create(username='svc-opencall', defaults={'email':'svc-opencall@systimus.local'})
   u.set_password('<INVENTORY_API_PASSWORD>'); u.is_active=True; u.save()
   p,_ = UserProfile.objects.get_or_create(user=u); p.role='super_admin'; p.save()
   print('OK:', u.username, p.role)
   "
   ```
4. **Verify auth** (inside the Inventory container, or curl from anywhere):
   ```bash
   python manage.py shell -c "
   from django.contrib.auth import authenticate
   u = authenticate(username='svc-opencall', password='<INVENTORY_API_PASSWORD>')
   print('auth OK, role:', u.userprofile.role) if u else print('auth FAILED')"
   ```
5. **Backfill existing part-cases** (idempotent; run in the Opencall backend container):
   ```bash
   node dist/scripts/backfillHpStockSync.js
   # or: pnpm --filter @opencall/api hp-stock:backfill
   ```

## Hardening backlog (NOT yet implemented — deferred by decision)

Current design works at present scale (~1.4k cases, periodic report generation). The items
below are known gaps, roughly prioritized. Nothing here is done yet.

### 1. Reliability — silent failures (highest priority)
- **Risk:** sync is fire-and-forget with swallowed errors. If Inventory is down or a request
  fails, that case is never synced and no one is notified. No retry, no dead-letter.
- **Fix (cheap):** schedule the idempotent backfill nightly (e.g. Dokploy Schedules) as a
  reconcile safety net — it re-drives anything missed.
- **Fix (fuller):** retry-with-backoff in `syncPartToInventory`; on final failure, record the
  case in an Opencall `inventory_sync_failures` table (needs an Opencall migration) for
  visibility and re-driving.
- **Inventory change needed:** no.

### 2. Scalability — unbounded concurrency on bulk (high)
- **Risk:** a report with many part-rows fires one sync per row with no limit — each does ~4
  Postgres queries (pool capped at 10) + 2 HTTP calls. Large reports can exhaust the pool
  (stalling report generation) and hammer the Inventory API (N+1 HTTP).
- **Fix:** a small concurrency limiter (e.g. cap at 5–10 in-flight) around the sync, plus the
  retry from item 1. Opencall-only, contained change.
- **Inventory change needed:** no.

### 3. Security — over-privileged service account (high)
- **Risk:** `svc-opencall` is `super_admin` on a publicly reachable API. It only needs to
  create/update HP Stock items but can do everything in Inventory.
- **Fixes:** rotate the credentials (they were exposed in screenshots during setup);
  IP-allowlist the Inventory API to the Opencall host if it has a stable IP; longer term, a
  least-privilege role/permission scoped to HP Stock.
- **Inventory change needed:** least-privilege role = yes; rotate/allowlist = no.
- **Note:** the service user must currently be admin/super_admin/manager so its lookup is not
  region-scoped (else dedup misses other regions → duplicates). A scoped role must preserve
  cross-region read for the sync.

### 4. Data integrity — no unique constraint on `case_id` (medium)
- **Risk:** the upsert is GET-then-POST; two concurrent syncs for the same case could both
  create → duplicate. Rare today, possible under bulk.
- **Fix:** unique index on `HPStockItem.case_id`.
- **Inventory change needed:** yes (migration).

### 5. Decoupling — background queue / outbox (later, only if volume grows)
- Move the sync off the request path into a durable queue/outbox (retries, backpressure,
  horizontal scale). More infrastructure; overkill at current volume.

## Security notes

- Rotate any secrets exposed during setup: `DATABASE_URL` password, `JWT_ACCESS_SECRET`,
  `ADMIN_COOKIE_SECRET`, `ADMIN_SESSION_SECRET`, and `INVENTORY_API_PASSWORD` (update it in
  both the Opencall env and the `svc-opencall` user together). Rotating `JWT_ACCESS_SECRET`
  invalidates sessions — do it in a maintenance window.
