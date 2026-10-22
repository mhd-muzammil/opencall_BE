# Ticketing System — Renderways customers and tickets in OpenCall

The **Ticketing System** section of the admin console (`/admin/ticketing`, SUPER_ADMIN
only) shows the customers of the Renderways (RTPL) customer app and website —
rtpl.systimus.in — and every service ticket they raise. It is **read live** from the
Renderways API on each page load; OpenCall stores nothing and writes nothing back.

```
Renderways app / website ──► Renderways API (tsapi.systimus.in) ──► OpenCall backend /api/v1/ticketing ──► OpenCall admin console
        customers raise tickets          MongoDB                       read-only proxy, SUPER_ADMIN            Ticketing System
```

## What it shows

- **Customers** — name, mobile, email (blank for people who signed up with just a mobile
  number), company, address, joined / last sign-in, update preferences, active or
  deactivated, with search.
- **One customer** — all of the above plus every ticket they have raised.
- **Tickets** — filter by status, priority and overdue SLA; search by ticket number or
  subject.
- **One ticket** — device, visit location and slot, technician, SLA and cost, the
  reported problem with attachments, the full conversation (Renderways staff-only
  notes are marked *Internal note*), the resolution and rating, and the history.

## Files

All additive except two registration lines:

| Repo | File | |
|---|---|---|
| opencallbackend | `backend/src/services/renderways/renderwaysClient.ts` | the only code that talks to Renderways |
| opencallbackend | `backend/src/services/renderways/ticketingParams.ts` (+ `.test.ts`) | query/id parsing |
| opencallbackend | `backend/src/controllers/renderwaysTicketingController.ts` | |
| opencallbackend | `backend/src/routes/renderwaysTicketingRoutes.ts` | SUPER_ADMIN guard |
| opencallbackend | `backend/src/routes/index.ts` | **edited**: registers `/ticketing` |
| opencallfrontend | `frontend/src/lib/ticketingApiClient.ts` | |
| opencallfrontend | `frontend/src/features/ticketing/ticketingUi.tsx` | |
| opencallfrontend | `frontend/src/app/admin/ticketing/**` | the three pages |
| opencallfrontend | `frontend/src/app/admin/layout.tsx` | **edited**: one nav item |

## Turning it on in production

OpenCall uses a **service key**, not a Renderways user account — no account is created
in the Renderways admin.

1. Make one long random key (letters, digits, `-` and `_`; at least 32 characters).
2. **On the Renderways backend** (Dokploy env) set `SERVICE_API_KEY=<the key>` and
   redeploy it. This turns on Renderways' read-only `/api/integrations` routes.
3. **On the OpenCall backend** (Dokploy env) set:
   ```
   RENDERWAYS_API_URL=https://tsapi.systimus.in
   RENDERWAYS_API_KEY=<the same key>
   ```
   They are read from `process.env` (like the Payroll keys), so `config/env.ts` needs no
   change. Redeploy the backend.
4. Open the admin console as a super admin → **Ticketing System**.

Until both variables are set, the section loads and says Renderways is not connected;
nothing else in OpenCall depends on them.

## Notes

- The key is sent as an `X-Service-Key` header to `/api/integrations/customers`,
  `/customers/:id`, `/tickets` and `/tickets/:id` — GETs only. Renderways only ever
  returns customers there (never staff), and the key opens no other route.
- Renderways ids are validated before they go into a Renderways URL; only known filters
  are passed on.
- To change the key, set the new value on both backends and redeploy both; until they
  match, the page shows "Renderways rejected the service key".
