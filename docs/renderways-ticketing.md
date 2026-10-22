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

1. **In Renderways**, create a service account for OpenCall: Admin → Customers & staff →
   add a staff member with role **Admin** (for example `opencall-bot@renderways.in`) and a
   long random password. Use it only here.
2. **On the OpenCall backend** (Dokploy / server env), set:
   ```
   RENDERWAYS_API_URL=https://tsapi.systimus.in
   RENDERWAYS_API_USER=opencall-bot@renderways.in     # email or mobile number
   RENDERWAYS_API_PASSWORD=••••••
   ```
   They are read from `process.env` (like the Payroll keys), so `config/env.ts` needs no
   change. Restart the backend.
3. Open the admin console as a super admin → **Ticketing System**.

Until the three variables are set, the section loads and says Renderways is not
connected; nothing else in OpenCall depends on them.

## Notes

- The service account signs in once and its token is reused for a day (Renderways
  tokens last seven), so OpenCall stays far below Renderways' sign-in rate limit.
- Renderways ids are validated before they go into a Renderways URL; only known filters
  are passed on.
- Changing the service account's password in Renderways stops the section until the
  OpenCall env is updated — the page then shows the sign-in error.
