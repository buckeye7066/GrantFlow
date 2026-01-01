# GrantFlow Deployment (Vercel + Railway)

## Goal
Serve the app at `https://www.axiombiolabs.org/grantflow` with:
- Frontend (Vercel) under `/grantflow/*`
- Backend (Railway) under `/api/*`

## 1) Vercel
- Framework: Vite
- Build command: `npm run build`
- Output directory: `dist`
- DNS: Managed by Vercel for `www.axiombiolabs.org`

This repo is already configured for production base path `/grantflow/` via `vite.config.ts`.

The included `vercel.json` handles routing and rewrites:
- Redirects `/` to `/grantflow`
- Proxies `/api/*` and `/grantflow/api/*` to Railway backend
- Routes `/grantflow/*` to the frontend SPA

## 2) Railway
- Start command: `npm run start`
- Required env:
  - `NODE_ENV=production`
  - `ANYA_ADMIN_TOKEN=...`
  - `CORS_ORIGIN=https://www.axiombiolabs.org,https://app.axiombiolabs.org`
- Backend API URL: `grantflow-production.up.railway.app`

## 3) Verify
- `GET https://www.axiombiolabs.org/api/anya/status`
- `GET https://www.axiombiolabs.org/api/opportunities`
- `GET https://www.axiombiolabs.org/grantflow/`
