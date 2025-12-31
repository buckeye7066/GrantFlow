# GrantFlow Path 2 Deployment (Vercel + Railway + Cloudflare)

**Status:** ✅ Recommended Production Deployment Path

## Goal
Serve the app at `https://www.axiombiolabs.org/grantflow` with:
- Frontend (Vercel) under `/grantflow/*`
- Backend (Railway) under `/api/*`

## DNS Configuration Status

✅ **Completed Steps:**
- Cloudflare nameservers configured in GoDaddy
- SSL/TLS encryption enabled (Full Strict mode)
- Basic DNS records in place

⚠️ **Pending Configuration:**
- Cloudflare Origin Rules for path-based routing
- Vercel deployment and domain verification
- Railway service deployment and environment setup

📖 **For detailed migration guide:** See [`docs/DNS_MIGRATION.md`](docs/DNS_MIGRATION.md)
📋 **Pre-migration checklist:** See [`docs/VERCEL_DOMAIN_CHECKLIST.md`](docs/VERCEL_DOMAIN_CHECKLIST.md)

## 1) Vercel
- Framework: Vite
- Build command: `npm run build`
- Output directory: `dist`

This repo is already configured for production base path `/grantflow/` via `vite.config.ts`.

## 2) Railway
- Start command: `npm run start`
- Required env:
  - `NODE_ENV=production`
  - `ANYA_ADMIN_TOKEN=...`
  - `CORS_ORIGIN=https://www.axiombiolabs.org,https://app.axiombiolabs.org`

## 3) Cloudflare Origin Rules
Create two Origin Rules:

### Rule A (API)
If path starts with `/api/`:
- Override origin host: `<YOUR_RAILWAY_HOST>` (example: `your-app.up.railway.app`)
- Forward HTTPS

### Rule B (Frontend)
If path starts with `/grantflow/`:
- Override origin host: `<YOUR_VERCEL_HOST>` (example: `your-app.vercel.app`)
- Forward HTTPS

## 4) Verify
- `GET https://www.axiombiolabs.org/api/anya/status`
- `GET https://www.axiombiolabs.org/api/opportunities`
- `GET https://www.axiombiolabs.org/grantflow/`
