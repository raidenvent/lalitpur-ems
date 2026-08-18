# Lalitpur Metro EMS

React/Vite frontend with an Express/PostgreSQL API. The repository is set up
to deploy both parts as one Vercel project:

- Vite builds the frontend.
- `api/index.js` exports the existing Express application as a Vercel Function.
- `vercel.json` sends all `/api/*` requests to Express and preserves the SPA
  doctor-view routes.

## Local development

Install the root and backend packages, create the backend environment file,
then start both processes:

```bash
npm install
cp backend-files/backend/.env.example backend-files/backend/.env
npm --prefix backend-files/backend run seed
npm --prefix backend-files/backend run dev
npm run dev
```

The Vite development server proxies `/api` to `http://localhost:4000`.

## Vercel deployment

Import this repository into Vercel with the project root set to the repository
root. Keep the framework preset as Vite and add these Production environment
variables in Project Settings:

```text
DATABASE_URL=<managed PostgreSQL connection string>
JWT_SECRET=<long random secret>
PGSSL=true
CORS_ORIGIN=https://<your-vercel-domain>
PUBLIC_APP_URL=https://<your-vercel-domain>
NODE_ENV=production
```

Do not set `VITE_API_URL` on Vercel. The frontend and API share one origin, so
the frontend should call `/api` directly.

Initialize the managed database once from a trusted machine before the first
login:

```bash
DATABASE_URL='<managed PostgreSQL connection string>' \
JWT_SECRET='<same JWT secret configured in Vercel>' \
PGSSL=true \
npm --prefix backend-files/backend run seed
```

The seed command prints the initial accounts. Change those passwords before
real use.

After deployment, verify the API and database together:

```text
https://<your-vercel-domain>/api/health
```

A healthy deployment returns `{"ok":true,"database":"connected",...}`. A
503 response means the function is running but PostgreSQL is unavailable or
misconfigured. A function configuration error usually means `JWT_SECRET` is
missing.

## Build checks

```bash
npm run lint
npm run build
```

The detailed API and database documentation remains in
`backend-files/backend/README.md`.
