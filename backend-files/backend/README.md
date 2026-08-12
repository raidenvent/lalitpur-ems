# LMC EMS Backend

Node.js/Express + PostgreSQL API for the Lalitpur Metro Pre-Hospital Emergency
Care Management System. This replaces the `window.storage` prototype
persistence layer in `lmc-ems.jsx` with a real, durable, multi-user backend.

## Why this can't run inside the chat sandbox

This code was written and syntax-checked here, but the sandbox has no
Postgres server and no exposed network port, so there is no live URL to
hand you. Everything below is what you run **on your own machine or host**.

## 1. Get a Postgres database

Any of these work:
- Local: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=lmc_ems -e POSTGRES_USER=lmc_ems -e POSTGRES_DB=lmc_ems postgres:16`
- Managed: Render, Railway, Neon, Supabase, or AWS RDS — copy the connection string they give you.

## 2. Configure

```bash
cd backend
cp .env.example .env
# edit .env:
#   DATABASE_URL=<your connection string>
#   JWT_SECRET=$(openssl rand -hex 32)
#   PGSSL=false   (local docker)  |  leave default true (managed hosts)
```

## 3. Install, seed, run

```bash
npm install
npm run seed     # applies schema.sql + creates one login per role
npm run dev       # http://localhost:4000
```

The seed script prints four phone/password pairs — one per role
(Admin/Metro/Paramedic/Doctor). **Change these before any real use** — they
exist only so you can log in on day one.

## 4. API shape

All routes are under `/api`. Auth: `POST /api/auth/login` returns a JWT;
send it as `Authorization: Bearer <token>` on every other call.

| Route | Role | Purpose |
|---|---|---|
| `POST /api/cases` | Metro, Admin | Create case (§3) |
| `GET /api/cases?q=&status=` | any | Dashboard list/search |
| `GET /api/cases/:encId` | any | Full case (Doctor gets caller PII stripped) |
| `POST /api/cases/:encId/timeline` | Paramedic | Timeline button press (§5) |
| `PATCH /api/cases/:encId/assessment` | Paramedic | ABCDE / stroke / MI / trauma fields |
| `POST /api/cases/:encId/vitals` | Paramedic | New vitals reading |
| `POST /api/cases/:encId/medications` | Paramedic | Medication entry |
| `POST /api/cases/:encId/interventions` | Paramedic | Intervention entry |
| `PUT /api/cases/:encId/destination` | Paramedic | Destination + consent if alternative (§12) |
| `PATCH /api/cases/:encId/handover` | Paramedic | Handover fields / arrival / handover marks |
| `POST /api/cases/:encId/close` | Paramedic | Close case — server re-validates blockers |
| `GET /api/cases/:encId/qr` | any | Real QR PNG (base64) for the secure case URL |
| `GET/POST /api/admin/users` | Admin | User management |
| `GET/POST /api/admin/facilities`, `/ambulances` | Admin | Config |
| `GET /api/admin/reports?from=&to=` | Admin | Aggregate stats + response-time metrics (§23) |

Every mutating route re-checks the caller's role server-side
(`requireRole`) — the frontend's role-based UI is a convenience, not the
security boundary, per §16/§24.

## 5. Point the frontend at this backend

In `lmc-ems.jsx`, the **only** thing that needs to change is the `db`
object — every UI component already calls `db.getCase`, `db.putCase`,
`db.getIndex`, etc. Replace the `window.storage`-backed implementations
with `fetch` calls to this API, e.g.:

```js
const API = "http://localhost:4000/api";
let authToken = null; // set after login

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...opts.headers,
    },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.status === 204 ? null : res.json();
}

const db = {
  getCase: (encId) => api(`/cases/${encId}`),
  getIndex: () => api(`/cases`),
  // putCase() goes away — replace direct-document overwrites with the
  // specific mutation endpoints above (postTimeline, patchAssessment,
  // postVitals, ...), one per user action, matching what the UI already
  // does semantically. This is also what gives you real audit-log
  // granularity instead of "case updated".
};
```

Also replace the prototype's role-picker `LoginScreen` with a real form
that posts to `POST /api/auth/login` and stores the returned JWT (e.g. in
memory + `sessionStorage`, not `localStorage`, to limit token lifetime
exposure) instead of a free-text name+role.

## 6. Hardening before production (not done here — flagging explicitly)

- **DB role separation**: create a low-privilege `app` Postgres role for
  the backend that has `INSERT`-only on `audit_log` (no `UPDATE`/`DELETE`),
  enforcing the immutable-audit-trail requirement (§17) at the database
  level, not just in application code.
- **Consent documents**: `consent_records.document_url` / `signature_url`
  currently just store a pointer string — wire these to real object storage
  (S3-compatible) with signed upload URLs.
- **QR URL signing**: the `/qr` endpoint builds a plain `/case/:encId` URL.
  For production, make the doctor-view URL a short-lived signed token
  (e.g. JWT with a narrow scope + expiry) instead of the raw EncID, so a
  photographed QR code can't be reused indefinitely.
- **True offline-first** on the paramedic client (service worker + local
  queue that survives an app close), per §20's stretch goal.
- **Backups / PITR** on the Postgres instance — this is a medico-legal
  record store.
